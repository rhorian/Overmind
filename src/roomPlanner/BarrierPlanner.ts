import {getCutTiles} from '../algorithms/minCut';
import {RoomPlanner} from './RoomPlanner';
import {Colony} from '../Colony';
import {Mem} from '../memory';
import {log} from '../lib/logger/log';

export interface BarrierPlannerMemory {
	barrierLookup: { [roadCoordName: string]: boolean };
}

let memoryDefaults = {
	barrierLookup: {},
};

export class BarrierPlanner {

	roomPlanner: RoomPlanner;
	colony: Colony;
	barrierPositions: RoomPosition[];

	static settings = {
		buildBarriersAtRCL: 3,
		padding           : 3, // allow this much space between structures and barriers
	};

	constructor(roomPlanner: RoomPlanner) {
		this.roomPlanner = roomPlanner;
		this.colony = roomPlanner.colony;
		this.barrierPositions = [];
	}

	get memory(): BarrierPlannerMemory {
		return Mem.wrap(this.colony.memory, 'barrierPlanner', memoryDefaults);
	}

	private computeBarrierPositions(hatcheryPos: RoomPosition, commandCenterPos: RoomPosition,
									upgradeSitePos: RoomPosition): RoomPosition[] {
		let rectArray = [];
		let padding = BarrierPlanner.settings.padding;
		if (hatcheryPos) {
			let {x, y} = hatcheryPos;
			let [x1, y1] = [Math.max(x - 5 - padding, 0), Math.max(y - 4 - padding, 0)];
			let [x2, y2] = [Math.min(x + 5 + padding, 49), Math.min(y + 6 + padding, 49)];
			rectArray.push({x1: x1, y1: y1, x2: x2, y2: y2});
		}
		if (commandCenterPos) {
			let {x, y} = commandCenterPos;
			let [x1, y1] = [Math.max(x - 3 - padding, 0), Math.max(y - 0 - padding, 0)];
			let [x2, y2] = [Math.min(x + 0 + padding, 49), Math.min(y + 5 + padding, 49)];
			rectArray.push({x1: x1, y1: y1, x2: x2, y2: y2});
		}
		if (upgradeSitePos) {
			let {x, y} = upgradeSitePos;
			let [x1, y1] = [Math.max(x - 1, 0), Math.max(y - 1, 0)];
			let [x2, y2] = [Math.min(x + 1, 49), Math.min(y + 1, 49)];
			rectArray.push({x1: x1, y1: y1, x2: x2, y2: y2});
		}
		// Get Min cut
		let barrierCoords = getCutTiles(this.colony.name, rectArray, true, 2, false);
		return _.map(barrierCoords, coord => new RoomPosition(coord.x, coord.y, this.colony.name));
	}

	init(): void {

	}

	/* Write everything to memory after roomPlanner is closed */
	finalize(): void {
		this.memory.barrierLookup = {};
		if (this.barrierPositions.length == 0) {
			if (this.roomPlanner.storagePos && this.roomPlanner.hatcheryPos) {
				this.barrierPositions = this.computeBarrierPositions(this.roomPlanner.hatcheryPos,
																	 this.roomPlanner.storagePos,
																	 this.colony.controller.pos);
			} else {
				log.error(`Couldn't generate barrier plan for ${this.colony.name}!`);
			}
		}
		for (let pos of this.barrierPositions) {
			this.memory.barrierLookup[pos.coordName] = true;
		}
	}

	/* Quick lookup for if a barrier should be in this position. Barriers returning false won't be maintained. */
	barrierShouldBeHere(pos: RoomPosition): boolean {
		return this.memory.barrierLookup[pos.coordName] || false;
	}

	/* Create construction sites for any buildings that need to be built */
	private buildMissing(): void {
		// Max buildings that can be placed each tick
		let count = RoomPlanner.settings.maxSitesPerColony - this.colony.constructionSites.length;
		// Build missing roads
		let barrierPositions = [];
		for (let coords of _.keys(this.memory.barrierLookup)) {
			let [x, y] = coords.split(':');
			barrierPositions.push(new RoomPosition(parseInt(x, 10), parseInt(y, 10), this.colony.name));
		}
		for (let pos of barrierPositions) {
			if (count > 0 && RoomPlanner.shouldBuild(STRUCTURE_RAMPART, pos)) {
				let ret = pos.createConstructionSite(STRUCTURE_RAMPART);
				if (ret != OK) {
					log.error(`${this.colony.name}: couldn't create rampart site at ${pos.print}. Result: ${ret}`);
				} else {
					count--;
				}
			}
		}
	}

	run(): void {
		if (this.roomPlanner.active) {
			if (this.roomPlanner.storagePos && this.roomPlanner.hatcheryPos) {
				this.barrierPositions = this.computeBarrierPositions(this.roomPlanner.hatcheryPos,
																	 this.roomPlanner.storagePos,
																	 this.colony.controller.pos);
			}
			this.visuals();
		} else {
			if (this.colony.level >= BarrierPlanner.settings.buildBarriersAtRCL &&
				Game.time % RoomPlanner.settings.siteCheckFrequency == this.colony.id + 1) {
				this.buildMissing();
			}
		}
	}

	visuals(): void {
		for (let pos of this.barrierPositions) {
			this.colony.room.visual.structure(pos.x, pos.y, STRUCTURE_RAMPART);
		}
	}

}