import {Overlord} from '../Overlord';
import {UpgradeSite} from '../../hiveClusters/upgradeSite';
import {Zerg} from '../../Zerg';
import {Tasks} from '../../tasks/Tasks';
import {OverlordPriority} from '../priorities_overlords';
import {profile} from '../../profiler/decorator';
import minBy from 'lodash.minby';
import {Pathing} from '../../pathing/pathing';
import {CreepSetup} from '../CreepSetup';

class UpgraderSetup extends CreepSetup {
	static role = 'upgrader';

	constructor(sizeLimit: number) {
		super(UpgraderSetup.role, {
			pattern  : [WORK, WORK, WORK, CARRY, MOVE],
			sizeLimit: sizeLimit,
		});
	}
}

@profile
export class UpgradingOverlord extends Overlord {

	upgraders: Zerg[];
	upgradeSite: UpgradeSite;
	settings: { [property: string]: number };
	room: Room;	//  Operates in owned room

	constructor(upgradeSite: UpgradeSite, priority = OverlordPriority.upgrading.upgrade) {
		super(upgradeSite, 'upgrade', priority);
		this.upgraders = this.creeps('upgrader');
		this.upgradeSite = upgradeSite;
	}

	init() {
		let upgradePower = _.sum(_.map(this.lifetimeFilter(this.upgraders), creep => creep.getActiveBodyparts(WORK)));
		if (upgradePower < this.upgradeSite.upgradePowerNeeded) {
			let workPartsPerUpgraderUnit = 3; // TODO: Hard-coded
			let upgraderSize = Math.ceil(this.upgradeSite.upgradePowerNeeded / workPartsPerUpgraderUnit);
			this.requestCreep(new UpgraderSetup(upgraderSize));
		}
		this.creepReport(UpgraderSetup.role, upgradePower, this.upgradeSite.upgradePowerNeeded);
	}

	private handleUpgrader(upgrader: Zerg): void {
		if (upgrader.carry.energy > 0) {
			// Repair link
			if (this.upgradeSite.link && this.upgradeSite.link.hits < this.upgradeSite.link.hitsMax) {
				upgrader.task = Tasks.repair(this.upgradeSite.link);
				return;
			}
			// Repair container
			if (this.upgradeSite.battery && this.upgradeSite.battery.hits < this.upgradeSite.battery.hitsMax) {
				upgrader.task = Tasks.repair(this.upgradeSite.battery);
				return;
			}
			// Build construction site
			if (this.upgradeSite.inputConstructionSite) {
				upgrader.task = Tasks.build(this.upgradeSite.inputConstructionSite);
				return;
			}
			// Sign controller if needed
			if (!this.upgradeSite.controller.signedByMe && 							// <DO-NOT-MODIFY>: see license
				!this.upgradeSite.controller.signedByScreeps) {						// <DO-NOT-MODIFY>
				upgrader.task = Tasks.signController(this.upgradeSite.controller); 	// <DO-NOT-MODIFY>
				return;
			}
			upgrader.task = Tasks.upgrade(this.upgradeSite.controller);
		} else {
			// Recharge from link or battery
			if (this.upgradeSite.link && this.upgradeSite.link.energy > 0) {
				upgrader.task = Tasks.withdraw(this.upgradeSite.link);
			} else if (this.upgradeSite.battery && this.upgradeSite.battery.energy > 0) {
				upgrader.task = Tasks.withdraw(this.upgradeSite.battery);
			}
			// Find somewhere else to recharge from
			else {
				let rechargeTargets = _.filter(_.compact([this.colony.storage!,
														  this.colony.terminal!,
														  ..._.map(this.colony.miningSites, site => site.output!),
														  ...this.colony.tombstones]),
											   s => s.energy > 0);
				let target = minBy(rechargeTargets, (s: RoomObject) => Pathing.distance(this.upgradeSite.pos, s.pos));
				if (target) upgrader.task = Tasks.withdraw(target);
			}
		}
	}

	run() {
		for (let upgrader of this.upgraders) {
			if (upgrader.isIdle) {
				this.handleUpgrader(upgrader);
			}
			upgrader.run();
		}
	}
}
