/* eslint-disable @typescript-eslint/no-non-null-assertion */
import TaskNotesPlugin from "../main";
import { BasesViewBase } from "./BasesViewBase";
import { TaskInfo } from "../types";
import { identifyTaskNotesFromBasesData } from "./helpers";
import { createTaskCard } from "../ui/TaskCard";

type Quadrant = "urgent-important" | "urgent-not-important" | "not-urgent-important" | "not-urgent-not-important";

export class EisenhowerMatrixView extends BasesViewBase {
	type = "tasknoteEisenhowerMatrix";
	private matrixContainer: HTMLElement | null = null;
	private taskInfoCache = new Map<string, TaskInfo>();

	constructor(controller: any, containerEl: HTMLElement, plugin: TaskNotesPlugin) {
		super(controller, containerEl, plugin);
		(this.dataAdapter as any).basesView = this;
	}

	protected setupContainer(): void {
		super.setupContainer();

		// Create matrix container
		const matrix = document.createElement("div");
		matrix.className = "eisenhower-matrix";
		matrix.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 12px; height: 100%; padding: 12px;";
		this.rootElement?.appendChild(matrix);
		this.matrixContainer = matrix;
	}

	async render(): Promise<void> {
		if (!this.rootElement) return;
		if (!this.matrixContainer) {
			// Container not set up yet, try to set it up
			this.setupContainer();
		}
		if (!this.matrixContainer) return;
		if (!this.data) return;
		if (!this.data.data || !Array.isArray(this.data.data)) {
			// Data not ready yet
			return;
		}

		try {
			const dataItems = this.dataAdapter.extractDataItems();
			if (!dataItems || dataItems.length === 0) {
				this.renderEmptyState();
				return;
			}
			const taskNotes = await identifyTaskNotesFromBasesData(dataItems, this.plugin);

			// Clear matrix
			this.matrixContainer.empty();

			if (taskNotes.length === 0) {
				this.renderEmptyState();
				return;
			}

			// Categorize tasks into quadrants
			const quadrants = this.categorizeTasks(taskNotes);

			// Render each quadrant
			this.renderQuadrant("urgent-important", quadrants.urgentImportant, "Urgent / Important");
			this.renderQuadrant("urgent-not-important", quadrants.urgentNotImportant, "Urgent / Not Important");
			this.renderQuadrant("not-urgent-important", quadrants.notUrgentImportant, "Not Urgent / Important");
			this.renderQuadrant("not-urgent-not-important", quadrants.notUrgentNotImportant, "Not Urgent / Not Important");
		} catch (error: any) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error rendering:", error);
			this.renderError(error);
		}
	}

	/**
	 * Categorize tasks into quadrants based on #urgent and #important tags
	 */
	private categorizeTasks(tasks: TaskInfo[]): {
		urgentImportant: TaskInfo[];
		urgentNotImportant: TaskInfo[];
		notUrgentImportant: TaskInfo[];
		notUrgentNotImportant: TaskInfo[];
	} {
		const quadrants = {
			urgentImportant: [] as TaskInfo[],
			urgentNotImportant: [] as TaskInfo[],
			notUrgentImportant: [] as TaskInfo[],
			notUrgentNotImportant: [] as TaskInfo[],
		};

		for (const task of tasks) {
			const hasUrgent = this.hasTag(task, "#urgent");
			const hasImportant = this.hasTag(task, "#important");

			if (hasUrgent && hasImportant) {
				quadrants.urgentImportant.push(task);
			} else if (hasUrgent && !hasImportant) {
				quadrants.urgentNotImportant.push(task);
			} else if (!hasUrgent && hasImportant) {
				quadrants.notUrgentImportant.push(task);
			} else {
				// Neither tag
				quadrants.notUrgentNotImportant.push(task);
			}

			// Cache task info
			this.taskInfoCache.set(task.path, task);
		}

		return quadrants;
	}

	/**
	 * Check if a task has a specific tag
	 */
	private hasTag(task: TaskInfo, tag: string): boolean {
		if (!task.tags || !Array.isArray(task.tags)) {
			return false;
		}
		// Normalize tag comparison (handle both with and without #)
		const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
		return task.tags.some((t) => {
			const normalized = t.startsWith("#") ? t : `#${t}`;
			return normalized.toLowerCase() === normalizedTag.toLowerCase();
		});
	}

	/**
	 * Render a single quadrant
	 */
	private renderQuadrant(quadrantId: Quadrant, tasks: TaskInfo[], title: string): void {
		if (!this.matrixContainer) return;

		const quadrant = document.createElement("div");
		quadrant.className = `eisenhower-matrix__quadrant eisenhower-matrix__quadrant--${quadrantId}`;
		quadrant.style.cssText = `
			display: flex;
			flex-direction: column;
			border: 2px solid var(--background-modifier-border);
			border-radius: 8px;
			background: var(--background-secondary);
			overflow: hidden;
		`;

		// Quadrant header
		const header = document.createElement("div");
		header.className = "eisenhower-matrix__quadrant-header";
		header.style.cssText = `
			padding: 12px;
			font-weight: 600;
			font-size: 14px;
			border-bottom: 1px solid var(--background-modifier-border);
			background: var(--background-primary-alt);
			display: flex;
			justify-content: space-between;
			align-items: center;
		`;
		header.createSpan({ text: title });
		const count = header.createSpan({
			text: `(${tasks.length})`,
			cls: "eisenhower-matrix__quadrant-count",
		});
		count.style.cssText = "font-weight: normal; color: var(--text-muted); font-size: 12px;";
		quadrant.appendChild(header);

		// Tasks container
		const tasksContainer = document.createElement("div");
		tasksContainer.className = "eisenhower-matrix__quadrant-tasks";
		tasksContainer.style.cssText = `
			flex: 1;
			overflow-y: auto;
			padding: 8px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		`;

		// Render task cards
		const visibleProperties = this.getVisibleProperties();
		const cardOptions = this.getCardOptions();

		if (tasks.length === 0) {
			const empty = document.createElement("div");
			empty.className = "eisenhower-matrix__quadrant-empty";
			empty.style.cssText = `
				padding: 20px;
				text-align: center;
				color: var(--text-muted);
				font-size: 12px;
			`;
			empty.textContent = "No tasks";
			tasksContainer.appendChild(empty);
		} else {
			for (const task of tasks) {
				const card = createTaskCard(task, this.plugin, visibleProperties, cardOptions);
				tasksContainer.appendChild(card);
			}
		}

		quadrant.appendChild(tasksContainer);
		this.matrixContainer.appendChild(quadrant);
	}

	private renderEmptyState(): void {
		if (!this.matrixContainer) return;
		const empty = document.createElement("div");
		empty.className = "tn-bases-empty";
		empty.style.cssText = `
			grid-column: 1 / -1;
			padding: 40px;
			text-align: center;
			color: var(--text-muted);
		`;
		empty.textContent = "No TaskNotes tasks found for this Base.";
		this.matrixContainer.appendChild(empty);
	}

	renderError(error: Error): void {
		if (!this.matrixContainer) return;
		const errorEl = document.createElement("div");
		errorEl.className = "tn-bases-error";
		errorEl.style.cssText = `
			grid-column: 1 / -1;
			padding: 20px;
			color: #d73a49;
			background: #ffeaea;
			border-radius: 4px;
			margin: 10px;
		`;
		errorEl.textContent = `Error loading Eisenhower matrix: ${error.message || "Unknown error"}`;
		this.matrixContainer.appendChild(errorEl);
	}

	protected async handleTaskUpdate(task: TaskInfo): Promise<void> {
		// Update cache
		this.taskInfoCache.set(task.path, task);
		// Full refresh since tasks might move quadrants
		this.debouncedRefresh();
	}

	private getCardOptions() {
		const now = new Date();
		const targetDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
		return {
			targetDate,
		};
	}
}

/**
 * Factory function for Bases registration.
 * Returns an actual EisenhowerMatrixView instance (extends BasesView).
 */
export function buildEisenhowerMatrixViewFactory(plugin: TaskNotesPlugin) {
	return function (controller: any, containerEl: HTMLElement): EisenhowerMatrixView {
		if (!containerEl) {
			console.error("[TaskNotes][EisenhowerMatrixView] No containerEl provided");
			throw new Error("EisenhowerMatrixView requires a containerEl");
		}

		return new EisenhowerMatrixView(controller, containerEl, plugin);
	};
}

