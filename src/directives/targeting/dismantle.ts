import {Directive} from '../Directive';
import {profile} from '../../profiler/decorator';
import {AttackStructurePriorities} from '../../settings/priorities';
import {Visualizer} from '../../visuals/Visualizer';

@profile
export class DirectiveDismantle extends Directive {

	static directiveName = 'dismantle';
	static color = COLOR_GREY;
	static secondaryColor = COLOR_YELLOW;

	constructor(flag: Flag) {
		super(flag);
	}

	getTarget(): Structure | undefined {
		if (!this.pos.isVisible) {
			return;
		}
		let targetedStructures = this.pos.lookFor(LOOK_STRUCTURES) as Structure[];
		for (let structure of targetedStructures) {
			for (let structureType of AttackStructurePriorities) {
				if (structure.structureType == structureType) {
					return structure;
				}
			}
		}
	}

	init(): void {
		// Add this structure to worker overlord's dismantle list
		let target = this.getTarget();
		if (target) {
			this.colony.overlords.work.dismantleStructures.push(target);
		}
	}

	run(): void {
		// Remove the directive once structures have been destroyed
		if (this.pos.isVisible && !this.getTarget()) {
			this.remove();
		}
	}

	visuals(): void {
		Visualizer.marker(this.pos, {color: 'yellow'});
	}
}

