import {Overlord} from '../Overlord';
import {BuildPriorities} from '../../settings/priorities';
import {Colony, ColonyStage, DEFCON} from '../../Colony';
import {profile} from '../../profiler/decorator';
import {Zerg} from '../../Zerg';
import {Tasks} from '../../tasks/Tasks';
import {OverlordPriority} from '../priorities_overlords';
import {CreepSetup} from '../CreepSetup';

export const WorkerSetup = new CreepSetup('worker', {
	pattern  : [WORK, CARRY, MOVE],
	sizeLimit: Infinity,
});

const WorkerEarlySetup = new CreepSetup('worker', {
	pattern  : [WORK, CARRY, MOVE, MOVE],
	sizeLimit: Infinity,
});

@profile
export class WorkerOverlord extends Overlord {

	workers: Zerg[];
	room: Room;
	repairStructures: Structure[];
	dismantleStructures: Structure[];
	rechargeObjects: (StructureStorage | StructureTerminal | StructureContainer | StructureLink | Tombstone)[];
	fortifyStructures: (StructureWall | StructureRampart)[];
	constructionSites: ConstructionSite[];
	nukeDefenseRamparts: StructureRampart[];

	static settings = {
		barrierHits       : {
			1: 3000,
			2: 3000,
			3: 3000,
			4: 10000,
			5: 100000,
			6: 1000000,
			7: 10000000,
			8: 30000000,
		},
		barrierLowHighHits: 100000,
	};

	constructor(colony: Colony, priority = OverlordPriority.ownedRoom.work) {
		super(colony, 'worker', priority);
		this.workers = this.creeps('worker');
		this.rechargeObjects = _.compact([this.colony.storage!,
										  this.colony.terminal!,
										  this.colony.upgradeSite.battery!,
										  ..._.map(this.colony.miningSites, site => site.output!),
										  ..._.filter(this.colony.tombstones, ts => ts.store.energy > 0)]);
		if (this.colony.hatchery && this.colony.hatchery.battery) {
			this.rechargeObjects.push(this.colony.hatchery.battery);
		}
		// Fortification structures
		this.fortifyStructures = _.sortBy(_.filter(this.room.barriers, s =>
			s.hits < WorkerOverlord.settings.barrierHits[this.colony.level]), s => s.hits);
		// Generate a list of structures needing repairing (different from fortifying except in critical case)
		this.repairStructures = _.filter(this.colony.repairables, function (structure) {
			if (structure.structureType == STRUCTURE_CONTAINER) {
				return structure.hits < 0.5 * structure.hitsMax;
			} else {
				return structure.hits < structure.hitsMax;
			}
		});
		let criticalHits = 1000; // Fortifying changes to repair status at this point
		let criticalBarriers = _.filter(this.fortifyStructures, s => s.hits <= criticalHits);
		this.repairStructures = this.repairStructures.concat(criticalBarriers);

		this.dismantleStructures = [];

		let homeRoomName = this.colony.room.name;
		let defcon = this.colony.defcon;
		this.constructionSites = _.filter(this.colony.constructionSites, function (site) {
			if (defcon > DEFCON.safe) {
				// Only build non-road, non-container sites in the home room if defcon is unsafe
				return site.pos.roomName == homeRoomName &&
					   site.structureType != STRUCTURE_CONTAINER &&
					   site.structureType != STRUCTURE_ROAD;
			} else {
				// Build all non-container sites in outpost and all sites in room if defcon is safe
				if (site.pos.roomName != homeRoomName) {
					return site.structureType != STRUCTURE_CONTAINER &&
						   !(site.room && site.room.dangerousHostiles.length > 0);
				} else {
					return true;
				}
			}
		});
		// Nuke defense response
		// this.nukeDefenseSites = _.filter(this.colony.room.constructionSites,
		// 								 site => site.pos.findInRange(FIND_NUKES, 3).length > 0);
		// let nukeRamparts = _.filter(this.colony.room.ramparts,
		// 							rampart => rampart.pos.findInRange(FIND_NUKES, 3).length > 0);
		// Nuke defense ramparts needing fortification
		this.nukeDefenseRamparts = _.filter(this.colony.room.ramparts, function (rampart) {
			if (rampart.pos.lookFor(LOOK_NUKES).length > 0) {
				return rampart.hits < 10000000 + 10000;
			} else if (rampart.pos.findInRange(FIND_NUKES, 3).length > 0) {
				return rampart.hits < 5000000 + 10000;
			} else {
				return false;
			}
		});
	}

	init() {
		// In case colony just started up, don't spawn workers until colony has something you can withdraw from
		if (_.compact(_.map(this.colony.miningSites, site => site.output)).length == 0) {
			return;
		}
		let setup = this.colony.stage == ColonyStage.Larva ? WorkerEarlySetup : WorkerSetup;
		let workPartsPerWorker = _.filter(this.generateProtoCreep(setup).body, part => part == WORK).length;
		if (this.colony.stage == ColonyStage.Larva) {
			// At lower levels, try to saturate the energy throughput of the colony
			let MAX_WORKERS = 7; // Maximum number of workers to spawn
			let energyPerTick = _.sum(_.map(this.colony.miningSites, site => site.energyPerTick));
			let energyPerTickPerWorker = 1.1 * workPartsPerWorker; // Average energy per tick when workers are working
			let workerUptime = 0.8;
			let numWorkers = Math.ceil(energyPerTick / (energyPerTickPerWorker * workerUptime));
			this.wishlist(Math.min(numWorkers, MAX_WORKERS), setup);
		} else {
			// At higher levels, spawn workers based on construction and repair that needs to be done
			let MAX_WORKERS = 3; // Maximum number of workers to spawn
			let constructionTicks = _.sum(_.map(this.colony.constructionSites,
												site => Math.max(site.progressTotal - site.progress, 0)))
									/ BUILD_POWER; // Math.max for if you manually set progress on private server
			let repairTicks = _.sum(_.map(this.repairStructures,
										  structure => structure.hitsMax - structure.hits)) / REPAIR_POWER;
			let fortifyTicks = 0.25 * _.sum(_.map(this.fortifyStructures,
												  barrier => WorkerOverlord.settings.barrierHits[this.colony.level]
															 - barrier.hits)) / REPAIR_POWER;
			if (this.colony.storage!.energy < 500000) {
				fortifyTicks = 0; // Ignore fortification duties below this energy level
			}
			let numWorkers = Math.ceil(2 * (constructionTicks + repairTicks + fortifyTicks) /
									   (workPartsPerWorker * CREEP_LIFE_TIME));
			this.wishlist(Math.min(numWorkers, MAX_WORKERS), setup);
		}
	}

	private repairActions(worker: Zerg) {
		let target = worker.pos.findClosestByMultiRoomRange(this.repairStructures);
		if (target) worker.task = Tasks.repair(target);
	}

	private buildActions(worker: Zerg) {
		let groupedSites = _.groupBy(this.constructionSites, site => site.structureType);
		for (let structureType of BuildPriorities) {
			if (groupedSites[structureType]) {
				let target = worker.pos.findClosestByMultiRoomRange(groupedSites[structureType]);
				if (target) {
					// Fixes issue #9 - workers freeze if creep sitting on square
					if (target.pos.lookFor(LOOK_CREEPS).length > 0) {
						let zerg = Game.zerg[_.first(target.pos.lookFor(LOOK_CREEPS)).name];
						if (zerg) zerg.moveOffCurrentPos();
						worker.say('move pls');
					}
					worker.task = Tasks.build(target);
					return;
				}
			}
		}
	}

	private dismantleActions(worker: Zerg) {
		let targets = _.filter(this.dismantleStructures, s => (s.targetedBy || []).length < 3);
		let target = worker.pos.findClosestByMultiRoomRange(targets);
		if (target) {
			_.remove(this.dismantleStructures, s => s == target);
			worker.task = Tasks.dismantle(target);
		}
	}

	private pavingActions(worker: Zerg) {
		let roomToRepave = this.colony.roadLogistics.workerShouldRepave(worker)!;
		this.colony.roadLogistics.registerWorkerAssignment(worker, roomToRepave);
		let target = worker.pos.findClosestByMultiRoomRange(this.colony.roadLogistics.repairableRoads(roomToRepave));
		if (target) worker.task = Tasks.repair(target);
	}

	private fortifyActions(worker: Zerg, fortifyStructures = this.fortifyStructures) {
		let lowBarriers: (StructureWall | StructureRampart)[];
		let highestBarrierHits = _.max(_.map(fortifyStructures, structure => structure.hits));
		if (highestBarrierHits > WorkerOverlord.settings.barrierLowHighHits) {
			// At high barrier HP, fortify only structures that are within a threshold of the lowest
			let lowestBarrierHits = _.min(_.map(fortifyStructures, structure => structure.hits));
			lowBarriers = _.filter(fortifyStructures, structure => structure.hits < lowestBarrierHits +
																   WorkerOverlord.settings.barrierLowHighHits);
		} else {
			// Otherwise fortify the lowest N structures
			let numBarriersToConsider = 5; // Choose the closest barrier of the N barriers with lowest hits
			lowBarriers = _.take(fortifyStructures, numBarriersToConsider);
		}
		let target = worker.pos.findClosestByMultiRoomRange(lowBarriers);
		if (target) worker.task = Tasks.fortify(target);
	}

	private upgradeActions(worker: Zerg) {
		// Sign controller if needed
		if (!this.colony.controller.signedByMe && 							// <DO-NOT-MODIFY>: see license
			!this.colony.controller.signedByScreeps) {						// <DO-NOT-MODIFY>
			worker.task = Tasks.signController(this.colony.controller); 	// <DO-NOT-MODIFY>
			return;
		}
		worker.task = Tasks.upgrade(this.room.controller!);
	}

	private rechargeActions(worker: Zerg) {
		let workerWithdrawLimit = this.colony.stage == ColonyStage.Larva ? 750 : 100;
		let rechargeTargets = _.filter(this.rechargeObjects, s => s instanceof Tombstone ||
																  s.energy > workerWithdrawLimit);
		let target = worker.pos.findClosestByMultiRoomRange(rechargeTargets);
		if (target) {
			worker.task = Tasks.withdraw(target);
		} else {
			// Harvest from a source if there is no recharge target available
			let availableSources = _.filter(this.room.sources,
											s => s.energy > 0 && s.pos.availableNeighbors().length > 0);
			let target = worker.pos.findClosestByMultiRoomRange(availableSources);
			if (target) worker.task = Tasks.harvest(target);
		}
	}

	private handleWorker(worker: Zerg) {
		if (worker.carry.energy > 0) {
			// Upgrade controller if close to downgrade
			if (this.colony.controller.ticksToDowngrade <= 1000) {
				this.upgradeActions(worker);
			}
			// Repair damaged non-road non-barrier structures
			else if (this.repairStructures.length > 0) {
				this.repairActions(worker);
			}
			// Build new structures
			else if (this.constructionSites.length > 0) {
				this.buildActions(worker);
			}
			// Build ramparts to block incoming nuke
			else if (this.nukeDefenseRamparts.length > 0) {
				this.fortifyActions(worker, this.nukeDefenseRamparts);
			}
			// Build and maintain roads
			else if (this.colony.roadLogistics.workerShouldRepave(worker) && this.colony.defcon == DEFCON.safe) {
				this.pavingActions(worker);
			}
			// Dismantle marked structures
			else if (this.dismantleStructures.length > 0 && this.colony.defcon == DEFCON.safe) {
				this.dismantleActions(worker);
			}
			// Fortify walls and ramparts
			else if (this.fortifyStructures.length > 0) {
				this.fortifyActions(worker);
			}
			// Upgrade controller if there's nothing left to do
			else {
				this.upgradeActions(worker);
			}
		} else {
			// Acquire more energy
			this.rechargeActions(worker);
		}
	}

	run() {
		for (let worker of this.workers) {
			if (worker.isIdle) {
				this.handleWorker(worker);
			}
			worker.run();
		}
	}
}
