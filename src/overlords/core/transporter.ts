import {Overlord} from '../Overlord';
import {Zerg} from '../../Zerg';
import {Tasks} from '../../tasks/Tasks';
import {Colony, ColonyStage} from '../../Colony';
import {BufferTarget, LogisticsNetwork, LogisticsRequest} from '../../logistics/LogisticsNetwork';
import {OverlordPriority} from '../priorities_overlords';
import {Pathing} from '../../pathing/pathing';
import {DirectiveLogisticsRequest} from '../../directives/logistics/logisticsRequest';
import {profile} from '../../profiler/decorator';
import {CreepSetup} from '../CreepSetup';


export const TransporterSetup = new CreepSetup('transport', {
	pattern  : [CARRY, CARRY, MOVE],
	sizeLimit: Infinity,
});

export const TransporterEarlySetup = new CreepSetup('transport', {
	pattern  : [CARRY, MOVE],
	sizeLimit: Infinity,
});


@profile
export class TransportOverlord extends Overlord {

	transporters: Zerg[];
	logisticsGroup: LogisticsNetwork;

	constructor(colony: Colony, priority = colony.getCreepsByRole(TransporterSetup.role).length > 0 ?
										   OverlordPriority.ownedRoom.transport : OverlordPriority.ownedRoom.firstTransport) {
		super(colony, 'logistics', priority);
		this.transporters = this.creeps(TransporterSetup.role);
		this.logisticsGroup = colony.logisticsNetwork;
	}

	private neededTransportPower(): number {
		let transportPower = 0;
		let scaling = this.colony.stage == ColonyStage.Larva ? 1.5 : 1.75; // aggregate round-trip multiplier
		// Add contributions to transport power from hauling energy from mining sites
		let dropoffLocation: RoomPosition;
		if (this.colony.commandCenter) {
			dropoffLocation = this.colony.commandCenter.pos;
		} else if (this.colony.hatchery && this.colony.hatchery.battery) {
			dropoffLocation = this.colony.hatchery.battery.pos;
		} else {
			return 0;
		}
		for (let siteID in this.colony.miningSites) {
			let site = this.colony.miningSites[siteID];
			if (site.overlord.miners.length > 0) {
				// Only count sites which have a container output and which have at least one miner present
				// (this helps in difficult "rebooting" situations)
				if (site.output && site.output instanceof StructureContainer) {
					transportPower += site.energyPerTick * (scaling * Pathing.distance(site.pos, dropoffLocation));
				} else if (site.shouldDropMine) {
					transportPower += .75 * site.energyPerTick * (scaling * Pathing.distance(site.pos, dropoffLocation));
				}
			}
		}
		if (this.colony.lowPowerMode) {
			// Reduce needed transporters when colony is in low power mode
			transportPower *= 0.5;
		}
		// Add transport power needed to move to upgradeSite
		transportPower += this.colony.upgradeSite.upgradePowerNeeded * scaling *
						  Pathing.distance(dropoffLocation, (this.colony.upgradeSite.battery ||
															 this.colony.upgradeSite).pos);
		return transportPower / CARRY_CAPACITY;
	}

	init() {
		let setup = this.colony.stage == ColonyStage.Larva ? TransporterEarlySetup : TransporterSetup;
		let transportPower = _.sum(_.map(this.lifetimeFilter(this.transporters),
										 creep => creep.getActiveBodyparts(CARRY)));
		let neededTransportPower = this.neededTransportPower();
		if (transportPower < neededTransportPower) {
			this.requestCreep(setup);
		}
		this.creepReport(setup.role, transportPower, neededTransportPower);
	}

	private handleTransporter(transporter: Zerg, request: LogisticsRequest | undefined) {
		if (request) {
			let choices = this.logisticsGroup.bufferChoices(transporter, request);
			let bestChoice = _.last(_.sortBy(choices, choice => choice.dQ / choice.dt));
			let task = null;
			let amount = this.logisticsGroup.predictedRequestAmount(transporter, request);
			if (amount > 0) { // store needs refilling
				if (request.target instanceof DirectiveLogisticsRequest) {
					task = Tasks.drop(request.target);
				} else {
					task = Tasks.transfer(request.target, request.resourceType);
				}
				// TODO: buffer with parent system is causing bugs
				if (bestChoice.targetRef != request.target.ref) {
					// If we need to go to a buffer first to get more stuff
					let buffer = deref(bestChoice.targetRef) as BufferTarget;
					let withdrawAmount = Math.min(buffer.store[request.resourceType] || 0,
						transporter.carryCapacity - _.sum(transporter.carry), amount);
					task = task.fork(Tasks.withdraw(buffer, request.resourceType, withdrawAmount));
				}
			} else if (amount < 0) { // store needs withdrawal
				if (request.target instanceof DirectiveLogisticsRequest) {
					let drops = request.target.drops[request.resourceType] || [];
					let resource = drops[0];
					if (resource) {
						task = Tasks.pickup(resource);
					}
				} else {
					task = Tasks.withdraw(request.target, request.resourceType);
				}
				if (task && bestChoice.targetRef != request.target.ref) {
					// If we need to go to a buffer first to deposit stuff
					let buffer = deref(bestChoice.targetRef) as BufferTarget | StructureLink;
					task = task.fork(Tasks.transfer(buffer, request.resourceType));
				}
			} else {
				// console.log(`${transporter.name} chooses a store with 0 amount!`);
				transporter.park();
			}
			// Assign the task to the transporter
			transporter.task = task;
		} else {
			if (transporter.carry.energy > 0) {
				let dropoffPoints: (StructureLink | StructureStorage)[] = _.compact([this.colony.storage!,
																					 ...this.colony.dropoffLinks]);
				// let bestDropoffPoint = minBy(dropoffPoints, function(dropoff: StructureLink | StructureStorage) {
				// 	let range = transporter.pos.getMultiRoomRangeTo(dropoff.pos);
				// 	if (dropoff instanceof StructureLink) {
				// 		return Math.max(range, this.colony.linkNetwork.getDropoffAvailability(dropoff));
				// 	} else {
				// 		return range;
				// 	}
				// });
				let bestDropoffPoint = transporter.pos.findClosestByMultiRoomRange(dropoffPoints);
				if (bestDropoffPoint) transporter.task = Tasks.transfer(bestDropoffPoint);
			} else {
				let parkingSpot = transporter.pos;
				if (this.colony.storage) {
					parkingSpot = this.colony.storage.pos;
				} else if (this.colony.roomPlanner.storagePos) {
					parkingSpot = this.colony.roomPlanner.storagePos;
				}
				transporter.park(parkingSpot);
			}
		}
	}

	private handleBigTransporter(bigTransporter: Zerg) {
		let bestRequestViaStableMatching = this.logisticsGroup.matching[bigTransporter.name];
		this.handleTransporter(bigTransporter, bestRequestViaStableMatching);
	}

	/* Handles small transporters, which don't do well with the logisticsNetwork's stable matching system */
	private handleSmolTransporter(smolTransporter: Zerg) {
		// Just perform a single-sided greedy selection of all requests
		let bestRequestViaGreedy = _.first(this.logisticsGroup.transporterPreferences(smolTransporter));
		this.handleTransporter(smolTransporter, bestRequestViaGreedy);
	}

	run() {
		for (let transporter of this.transporters) {
			if (transporter.isIdle) {
				// if (transporter.carryCapacity >= LogisticsNetwork.settings.carryThreshold) {
				// 	this.handleBigTransporter(transporter);
				// } else {
				// 	this.handleSmolTransporter(transporter);
				// }
				this.handleSmolTransporter(transporter);
			}
			transporter.run();
		}
	}
}
