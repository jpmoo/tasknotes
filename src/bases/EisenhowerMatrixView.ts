/* eslint-disable @typescript-eslint/no-non-null-assertion */
import TaskNotesPlugin from "../main";
import { BasesViewBase } from "./BasesViewBase";
import { TaskInfo } from "../types";
import { identifyTaskNotesFromBasesData } from "./helpers";
import { createTaskCard } from "../ui/TaskCard";
import { VirtualScroller } from "../utils/VirtualScroller";
import { TFile } from "obsidian";

type Quadrant = "urgent-important" | "urgent-not-important" | "not-urgent-important" | "not-urgent-not-important" | "holding-pen";

export class EisenhowerMatrixView extends BasesViewBase {
	type = "tasknoteEisenhowerMatrix";
	private matrixContainer: HTMLElement | null = null;
	private taskInfoCache = new Map<string, TaskInfo>();
	private quadrantScrollers = new Map<string, VirtualScroller<TaskInfo>>();
	/**
	 * Threshold for enabling virtual scrolling in quadrants.
	 * Virtual scrolling activates when a quadrant has >= 50 tasks.
	 */
	private readonly VIRTUAL_SCROLL_THRESHOLD = 50;
	/**
	 * Fixed height for quadrants (approximately 5 task cards).
	 * Each task card is ~45px + 8px gap = ~53px per card.
	 * 5 cards × 53px = ~265px, plus padding = ~275px
	 */
	private readonly QUADRANT_FIXED_HEIGHT = 275; // pixels
	private draggedTaskPath: string | null = null;

	constructor(controller: any, containerEl: HTMLElement, plugin: TaskNotesPlugin) {
		super(controller, containerEl, plugin);
		(this.dataAdapter as any).basesView = this;
	}

	protected setupContainer(): void {
		super.setupContainer();

		// Create matrix container - 2x2 grid for quadrants + uncategorized region below
		const matrix = document.createElement("div");
		matrix.className = "eisenhower-matrix";
		matrix.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto auto; gap: 12px; height: 100%; padding: 12px;";
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

			// Clean up existing scrollers
			this.destroyQuadrantScrollers();
			
			// Clear matrix
			this.matrixContainer.empty();

			if (taskNotes.length === 0) {
				this.renderEmptyState();
				return;
			}

			// Categorize tasks into quadrants
			const quadrants = this.categorizeTasks(taskNotes);

			// Render each quadrant - top row: Important quadrants, bottom row: Not Important quadrants
			this.renderQuadrant("urgent-important", quadrants.urgentImportant, "Urgent / Important", "DO");
			this.renderQuadrant("not-urgent-important", quadrants.notUrgentImportant, "Not Urgent / Important", "DECIDE");
			this.renderQuadrant("urgent-not-important", quadrants.urgentNotImportant, "Urgent / Not Important", "DELEGATE");
			this.renderQuadrant("not-urgent-not-important", quadrants.notUrgentNotImportant, "Not Urgent / Not Important", "DEFER");
			// Render uncategorized region (spans full width below the matrix)
			this.renderQuadrant("holding-pen", quadrants.holdingPen, "Uncategorized");
		} catch (error: any) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error rendering:", error);
			this.renderError(error);
		}
	}

	/**
	 * Categorize tasks into quadrants based on yUrgent, nUrgent, yImportant, nImportant tags
	 * Tasks with none of these tags go to the uncategorized region
	 */
	private categorizeTasks(tasks: TaskInfo[]): {
		urgentImportant: TaskInfo[];
		urgentNotImportant: TaskInfo[];
		notUrgentImportant: TaskInfo[];
		notUrgentNotImportant: TaskInfo[];
		holdingPen: TaskInfo[];
	} {
		const quadrants = {
			urgentImportant: [] as TaskInfo[],
			urgentNotImportant: [] as TaskInfo[],
			notUrgentImportant: [] as TaskInfo[],
			notUrgentNotImportant: [] as TaskInfo[],
			holdingPen: [] as TaskInfo[],
		};

		for (const task of tasks) {
			const hasYImportant = this.hasTag(task, "yImportant");
			const hasNImportant = this.hasTag(task, "nImportant");
			const hasYUrgent = this.hasTag(task, "yUrgent");
			const hasNUrgent = this.hasTag(task, "nUrgent");

			// Check if task has any of the four tags
			const hasAnyTag = hasYImportant || hasNImportant || hasYUrgent || hasNUrgent;

			if (!hasAnyTag) {
				// No tags → uncategorized
				quadrants.holdingPen.push(task);
			} else {
				// Determine quadrant based on tags
				// n tags override y tags (explicit negative takes precedence)
				const isUrgent = hasYUrgent && !hasNUrgent;
				const isImportant = hasYImportant && !hasNImportant;

				if (isUrgent && isImportant) {
					quadrants.urgentImportant.push(task);
				} else if (isUrgent && !isImportant) {
					quadrants.urgentNotImportant.push(task);
				} else if (!isUrgent && isImportant) {
					quadrants.notUrgentImportant.push(task);
				} else {
					// Neither urgent nor important (or has negative tags)
					quadrants.notUrgentNotImportant.push(task);
				}
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
		const normalizedTag = tag.startsWith("#") ? tag.substring(1) : tag;
		return task.tags.some((t) => {
			const normalized = t.startsWith("#") ? t.substring(1) : t;
			return normalized.toLowerCase() === normalizedTag.toLowerCase();
		});
	}

	/**
	 * Render a single quadrant
	 */
	private renderQuadrant(quadrantId: Quadrant, tasks: TaskInfo[], title: string, backgroundLabel?: string): void {
		if (!this.matrixContainer) return;

		const quadrant = document.createElement("div");
		quadrant.className = `eisenhower-matrix__quadrant eisenhower-matrix__quadrant--${quadrantId}`;
		
		// Base styles for all quadrants
		let quadrantStyle = `
			display: flex;
			flex-direction: column;
			border: 2px solid var(--background-modifier-border);
			border-radius: 8px;
			background: var(--background-secondary);
			overflow: hidden;
			height: ${this.QUADRANT_FIXED_HEIGHT}px;
			flex-shrink: 0;
			position: relative;
		`;
		
		// Special styling for uncategorized region (spans full width)
		if (quadrantId === "holding-pen") {
			quadrantStyle += `grid-column: 1 / -1;`;
		}
		
		quadrant.style.cssText = quadrantStyle;
		
		// Add background label if provided
		if (backgroundLabel) {
			const label = document.createElement("div");
			label.className = "eisenhower-matrix__background-label";
			label.textContent = backgroundLabel;
			// Calculate center position of tasks area (excluding header)
			const headerHeight = 50;
			const availableHeight = this.QUADRANT_FIXED_HEIGHT - headerHeight;
			const tasksAreaCenter = headerHeight + (availableHeight / 2);
			label.style.cssText = `
				position: absolute;
				top: ${tasksAreaCenter}px;
				left: 50%;
				transform: translate(-50%, -50%);
				font-size: 90px;
				font-weight: 700;
				color: var(--text-muted);
				opacity: 0.04;
				pointer-events: none;
				user-select: none;
				z-index: 0;
				white-space: nowrap;
				line-height: 1;
				display: flex;
				align-items: center;
				justify-content: center;
			`;
			quadrant.appendChild(label);
		}

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
			position: relative;
			z-index: 1;
		`;
		header.createSpan({ text: title });
		const count = header.createSpan({
			text: `(${tasks.length})`,
			cls: "eisenhower-matrix__quadrant-count",
		});
		count.style.cssText = "font-weight: normal; color: var(--text-muted); font-size: 12px;";
		quadrant.appendChild(header);

		// Tasks container - fixed height with scrolling
		const tasksContainer = document.createElement("div");
		tasksContainer.className = "eisenhower-matrix__quadrant-tasks";
		// Calculate available height: fixed quadrant height minus header height (~50px)
		const headerHeight = 50;
		const availableHeight = this.QUADRANT_FIXED_HEIGHT - headerHeight;
		tasksContainer.style.cssText = `
			height: ${availableHeight}px;
			overflow-y: auto;
			padding: 8px;
			display: flex;
			flex-direction: column;
			gap: 8px;
			flex-shrink: 0;
			position: relative;
			z-index: 1;
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
		} else if (tasks.length >= this.VIRTUAL_SCROLL_THRESHOLD) {
			// Use virtual scrolling for large quadrants
			this.createVirtualQuadrant(tasksContainer, quadrantId, tasks, visibleProperties, cardOptions);
			// Setup drop handlers for the quadrant (virtual scrolling doesn't prevent drops)
			this.setupQuadrantDropHandlers(quadrant, quadrantId);
		} else {
			// Render normally for smaller quadrants
			for (const task of tasks) {
				try {
					// Wrap card in draggable container
					const cardWrapper = document.createElement("div");
					cardWrapper.className = "eisenhower-matrix__card-wrapper";
					cardWrapper.setAttribute("draggable", "true");
					cardWrapper.setAttribute("data-task-path", task.path);
					
					const card = createTaskCard(task, this.plugin, visibleProperties, cardOptions);
					cardWrapper.appendChild(card);
					tasksContainer.appendChild(cardWrapper);
					this.taskInfoCache.set(task.path, task);
					
					// Setup drag handlers
					this.setupCardDragHandlers(cardWrapper, task);
				} catch (error) {
					console.error(`[TaskNotes][EisenhowerMatrixView] Error creating card for ${task.path}:`, error);
					// Continue with next task instead of crashing
				}
			}
		}
		
		// Setup drop handlers for the quadrant
		this.setupQuadrantDropHandlers(quadrant, quadrantId);

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

	private createVirtualQuadrant(
		tasksContainer: HTMLElement,
		quadrantId: string,
		tasks: TaskInfo[],
		visibleProperties: string[],
		cardOptions: any
	): void {
		// Container height is already set by renderQuadrant, just ensure it's scrollable
		// Calculate available height: fixed quadrant height minus header height (~50px)
		const headerHeight = 50;
		const availableHeight = this.QUADRANT_FIXED_HEIGHT - headerHeight;
		tasksContainer.style.cssText = `
			height: ${availableHeight}px;
			overflow-y: auto;
			padding: 8px;
			position: relative;
			display: flex;
			flex-direction: column;
			flex-shrink: 0;
		`;

		// Clean up existing scroller for this quadrant if it exists
		const existingScroller = this.quadrantScrollers.get(quadrantId);
		if (existingScroller) {
			existingScroller.destroy();
		}

		const scroller = new VirtualScroller<TaskInfo>({
			container: tasksContainer,
			items: tasks,
			overscan: 3,
			renderItem: (task: TaskInfo) => {
				try {
					// Wrap card in draggable container for virtual scrolling
					const cardWrapper = document.createElement("div");
					cardWrapper.className = "eisenhower-matrix__card-wrapper";
					cardWrapper.setAttribute("draggable", "true");
					cardWrapper.setAttribute("data-task-path", task.path);
					
					const card = createTaskCard(task, this.plugin, visibleProperties, cardOptions);
					cardWrapper.appendChild(card);
					this.taskInfoCache.set(task.path, task);
					
					// Setup drag handlers
					this.setupCardDragHandlers(cardWrapper, task);
					
					return cardWrapper;
				} catch (error) {
					console.error(`[TaskNotes][EisenhowerMatrixView] Error creating card for ${task.path}:`, error);
					// Return empty div as fallback
					const fallback = document.createElement("div");
					fallback.textContent = `Error loading task: ${task.title || task.path}`;
					fallback.style.cssText = "padding: 8px; color: var(--text-error);";
					return fallback;
				}
			},
			getItemKey: (task: TaskInfo) => task.path,
		});

		this.quadrantScrollers.set(quadrantId, scroller);
	}

	private getCardOptions() {
		const now = new Date();
		const targetDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
		return {
			targetDate,
		};
	}

	private setupCardDragHandlers(cardWrapper: HTMLElement, task: TaskInfo): void {
		cardWrapper.addEventListener("dragstart", (e: DragEvent) => {
			this.draggedTaskPath = task.path;
			cardWrapper.classList.add("eisenhower-matrix__card--dragging");

			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", task.path);
			}
		});

		cardWrapper.addEventListener("dragend", () => {
			cardWrapper.classList.remove("eisenhower-matrix__card--dragging");

			// Clean up any lingering dragover classes
			this.matrixContainer?.querySelectorAll('.eisenhower-matrix__quadrant--dragover').forEach(el => {
				el.classList.remove('eisenhower-matrix__quadrant--dragover');
			});
			
			this.draggedTaskPath = null;
		});
	}

	private setupQuadrantDropHandlers(quadrant: HTMLElement, quadrantId: Quadrant): void {
		// Drag over handler
		quadrant.addEventListener("dragover", (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			quadrant.classList.add("eisenhower-matrix__quadrant--dragover");
		});

		// Drag leave handler
		quadrant.addEventListener("dragleave", (e: DragEvent) => {
			// Only remove if we're actually leaving the quadrant (not just moving to a child)
			const rect = quadrant.getBoundingClientRect();
			const x = (e as any).clientX;
			const y = (e as any).clientY;

			if (
				x < rect.left || x >= rect.right ||
				y < rect.top || y >= rect.bottom
			) {
				quadrant.classList.remove("eisenhower-matrix__quadrant--dragover");
			}
		});

		// Drop handler
		quadrant.addEventListener("drop", async (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			quadrant.classList.remove("eisenhower-matrix__quadrant--dragover");

			if (!this.draggedTaskPath) return;

			// Update tags based on target quadrant
			await this.handleTaskDrop(this.draggedTaskPath, quadrantId);

			this.draggedTaskPath = null;
		});
	}

	private async handleTaskDrop(taskPath: string, targetQuadrant: Quadrant): Promise<void> {
		try {
			const task = this.taskInfoCache.get(taskPath);
			if (!task) {
				// Try to load the task if not in cache
				const file = this.app.vault.getAbstractFileByPath(taskPath);
				if (!(file instanceof TFile)) return;
				
				const loadedTask = await this.plugin.cacheManager.getTaskInfo(taskPath);
				if (!loadedTask) return;
				
				await this.updateTaskTagsForQuadrant(loadedTask, targetQuadrant);
			} else {
				await this.updateTaskTagsForQuadrant(task, targetQuadrant);
			}

			// Refresh to show updated position
			this.debouncedRefresh();
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error updating task:", error);
		}
	}

	private async updateTaskTagsForQuadrant(task: TaskInfo, targetQuadrant: Quadrant): Promise<void> {
		// Get current tags (remove # prefix for storage - tags in frontmatter don't have #)
		const currentTags = (task.tags || []).map(t => t.startsWith("#") ? t.substring(1) : t);
		
		// Tag names (without # prefix, as they should be stored in frontmatter)
		const tagYUrgent = "yUrgent";
		const tagNUrgent = "nUrgent";
		const tagYImportant = "yImportant";
		const tagNImportant = "nImportant";

		// Build new tags array
		const newTags: string[] = [];
		
		// Keep all existing tags except the four eisenhower tags (we'll add them back if needed)
		for (const tag of currentTags) {
			const normalized = tag.toLowerCase();
			if (
				normalized !== tagYUrgent.toLowerCase() &&
				normalized !== tagNUrgent.toLowerCase() &&
				normalized !== tagYImportant.toLowerCase() &&
				normalized !== tagNImportant.toLowerCase()
			) {
				newTags.push(tag); // Keep original case
			}
		}

		// Add tags based on target quadrant - use all 4 tags to be explicit
		if (targetQuadrant === "holding-pen") {
			// Remove all eisenhower tags (already filtered above)
			// Don't add any tags - task remains uncategorized
		} else {
			// Determine which tags should be present based on target quadrant
			const shouldHaveUrgent = targetQuadrant === "urgent-important" || targetQuadrant === "urgent-not-important";
			const shouldHaveImportant = targetQuadrant === "urgent-important" || targetQuadrant === "not-urgent-important";

			// Add all 4 tags explicitly - set the appropriate y/n tags and remove the opposite ones
			if (shouldHaveUrgent) {
				newTags.push(tagYUrgent);
				// Don't add nUrgent (explicitly not urgent)
			} else {
				newTags.push(tagNUrgent);
				// Don't add yUrgent (explicitly not urgent)
			}
			
			if (shouldHaveImportant) {
				newTags.push(tagYImportant);
				// Don't add nImportant (explicitly not important)
			} else {
				newTags.push(tagNImportant);
				// Don't add yImportant (explicitly not important)
			}
		}

		// Use updateTask instead of updateTaskProperty because tags is not in FieldMapping
		// updateTask has special handling for tags that writes to frontmatter.tags correctly
		await this.plugin.taskService.updateTask(task, {
			tags: newTags.length > 0 ? newTags : undefined
		});
	}

	private destroyQuadrantScrollers(): void {
		for (const scroller of this.quadrantScrollers.values()) {
			scroller.destroy();
		}
		this.quadrantScrollers.clear();
	}

	/**
	 * Component lifecycle: Called when component is unloaded.
	 */
	onunload(): void {
		// Clean up virtual scrollers
		this.destroyQuadrantScrollers();
		this.taskInfoCache.clear();
		this.matrixContainer = null;
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

