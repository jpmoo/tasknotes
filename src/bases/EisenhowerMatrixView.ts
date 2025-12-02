/* eslint-disable @typescript-eslint/no-non-null-assertion */
import TaskNotesPlugin from "../main";
import { BasesViewBase } from "./BasesViewBase";
import { TaskInfo } from "../types";
import { identifyTaskNotesFromBasesData } from "./helpers";
import { createTaskCard } from "../ui/TaskCard";
import { VirtualScroller } from "../utils/VirtualScroller";
import { TFile } from "obsidian";

type Quadrant = "urgent-important" | "urgent-not-important" | "not-urgent-important" | "not-urgent-not-important" | "holding-pen" | "excluded";

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
	private draggedFromQuadrant: Quadrant | null = null;
	private quadrantOrderings: Map<Quadrant, Map<string, number>> = new Map();

	constructor(controller: any, containerEl: HTMLElement, plugin: TaskNotesPlugin) {
		super(controller, containerEl, plugin);
		(this.dataAdapter as any).basesView = this;
	}

	protected setupContainer(): void {
		super.setupContainer();

		// Create matrix container - 2x2 grid for quadrants + uncategorized + excluded regions below
		const matrix = document.createElement("div");
		matrix.className = "eisenhower-matrix";
		matrix.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto auto auto; gap: 12px; height: 100%; padding: 12px;";
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

			// Load quadrant orderings from config
			this.loadQuadrantOrderings();

			// Categorize tasks into quadrants
			const quadrants = this.categorizeTasks(taskNotes);

			// Apply custom ordering to each quadrant's tasks
			this.applyOrderingToQuadrants(quadrants);

			// Render each quadrant - top row: Important quadrants, bottom row: Not Important quadrants
			// First render with auto height to measure content
			this.renderQuadrant("urgent-important", quadrants.urgentImportant, "Urgent / Important", "DO", true);
			this.renderQuadrant("not-urgent-important", quadrants.notUrgentImportant, "Not Urgent / Important", "DECIDE", true);
			this.renderQuadrant("urgent-not-important", quadrants.urgentNotImportant, "Urgent / Not Important", "DELEGATE", true);
			this.renderQuadrant("not-urgent-not-important", quadrants.notUrgentNotImportant, "Not Urgent / Not Important", "DEFER", true);
			
			// Wait for DOM to render, then calculate and apply heights
			// Pass task counts to handle virtual scrolling cases
			const taskCounts = {
				"urgent-important": quadrants.urgentImportant.length,
				"not-urgent-important": quadrants.notUrgentImportant.length,
				"urgent-not-important": quadrants.urgentNotImportant.length,
				"not-urgent-not-important": quadrants.notUrgentNotImportant.length,
			};
			
			// Use requestAnimationFrame to ensure DOM is fully rendered before measuring
			requestAnimationFrame(() => {
				const maxHeight = this.calculateMaxQuadrantHeight(taskCounts);
				// Apply the maximum height to all four quadrants
				this.applyUniformHeightToQuadrants(maxHeight);
			});
			
			// Render uncategorized region (spans full width below the matrix) - fixed height
			this.renderQuadrant("holding-pen", quadrants.holdingPen, "Uncategorized", undefined, false, true);
			
			// Render excluded region (spans full width below uncategorized) - fixed height
			this.renderQuadrant("excluded", quadrants.excluded, "Excluded", undefined, false, true);
		} catch (error: any) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error rendering:", error);
			this.renderError(error);
		}
	}

	/**
	 * Check if a task is a subtask (has a project link to another task)
	 */
	private isSubtask(task: TaskInfo): boolean {
		if (!task.projects || task.projects.length === 0) {
			return false;
		}

		// Check if any project is a markdown link that resolves to a task file
		for (const project of task.projects) {
			if (typeof project === "string" && project.startsWith("[[") && project.endsWith("]]")) {
				const linkContent = project.slice(2, -2).trim();
				// Try to resolve the link
				const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(linkContent, "");
				if (resolvedFile instanceof TFile) {
					// Check if the resolved file is a task
					const metadata = this.app.metadataCache.getFileCache(resolvedFile);
					if (metadata?.frontmatter && this.plugin.cacheManager.isTaskFile(metadata.frontmatter)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Check if a task is blocked
	 */
	private isBlocked(task: TaskInfo): boolean {
		return task.isBlocked === true || (task.blockedBy !== undefined && task.blockedBy.length > 0);
	}

	/**
	 * Categorize tasks into quadrants based on yUrgent, nUrgent, yImportant, nImportant tags
	 * Tasks with none of these tags go to the uncategorized region
	 * Excluded region starts empty - users can drag tasks there manually
	 */
	private categorizeTasks(tasks: TaskInfo[]): {
		urgentImportant: TaskInfo[];
		urgentNotImportant: TaskInfo[];
		notUrgentImportant: TaskInfo[];
		notUrgentNotImportant: TaskInfo[];
		holdingPen: TaskInfo[];
		excluded: TaskInfo[];
	} {
		const quadrants = {
			urgentImportant: [] as TaskInfo[],
			urgentNotImportant: [] as TaskInfo[],
			notUrgentImportant: [] as TaskInfo[],
			notUrgentNotImportant: [] as TaskInfo[],
			holdingPen: [] as TaskInfo[],
			excluded: [] as TaskInfo[],
		};

		for (const task of tasks) {
			// Check if task has excluded tag first
			if (this.hasTag(task, "excluded")) {
				quadrants.excluded.push(task);
				// Cache task info
				this.taskInfoCache.set(task.path, task);
				continue;
			}

			const hasYImportant = this.hasTag(task, "yImportant");
			const hasNImportant = this.hasTag(task, "nImportant");
			const hasYUrgent = this.hasTag(task, "yUrgent");
			const hasNUrgent = this.hasTag(task, "nUrgent");

			// Check if task has any of the four tags
			const hasAnyTag = hasYImportant || hasNImportant || hasYUrgent || hasNUrgent;

			if (!hasAnyTag) {
				// No tags → uncategorized (including subtasks and blocked tasks)
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
	 * Load quadrant orderings from BasesViewConfig
	 */
	private loadQuadrantOrderings(): void {
		this.quadrantOrderings.clear();
		
		try {
			const orderingsJson = this.config?.get?.('quadrantOrderings');
			if (orderingsJson && typeof orderingsJson === 'string') {
				const orderings = JSON.parse(orderingsJson);
				for (const [quadrantId, taskOrderMap] of Object.entries(orderings)) {
					if (typeof taskOrderMap === 'object' && taskOrderMap !== null) {
						this.quadrantOrderings.set(
							quadrantId as Quadrant,
							new Map(Object.entries(taskOrderMap as Record<string, number>))
						);
					}
				}
			}
		} catch (error) {
			console.error('[EisenhowerMatrixView] Failed to load quadrant orderings:', error);
		}
	}

	/**
	 * Save quadrant orderings to BasesViewConfig
	 */
	private saveQuadrantOrderings(): void {
		try {
			const orderings: Record<string, Record<string, number>> = {};
			for (const [quadrantId, taskOrderMap] of this.quadrantOrderings.entries()) {
				orderings[quadrantId] = Object.fromEntries(taskOrderMap);
			}
			const orderingsJson = JSON.stringify(orderings);
			this.config?.set?.('quadrantOrderings', orderingsJson);
		} catch (error) {
			console.error('[EisenhowerMatrixView] Failed to save quadrant orderings:', error);
		}
	}

	/**
	 * Apply custom ordering to tasks in each quadrant
	 */
	private applyOrderingToQuadrants(quadrants: {
		urgentImportant: TaskInfo[];
		urgentNotImportant: TaskInfo[];
		notUrgentImportant: TaskInfo[];
		notUrgentNotImportant: TaskInfo[];
		holdingPen: TaskInfo[];
		excluded: TaskInfo[];
	}): void {
		const quadrantMap: Record<string, TaskInfo[]> = {
			'urgent-important': quadrants.urgentImportant,
			'not-urgent-important': quadrants.notUrgentImportant,
			'urgent-not-important': quadrants.urgentNotImportant,
			'not-urgent-not-important': quadrants.notUrgentNotImportant,
			'holding-pen': quadrants.holdingPen,
			'excluded': quadrants.excluded,
		};

		for (const [quadrantId, tasks] of Object.entries(quadrantMap)) {
			const ordering = this.quadrantOrderings.get(quadrantId as Quadrant);
			if (ordering && ordering.size > 0) {
				// Sort tasks by their stored order, with un-ordered tasks at the end
				tasks.sort((a, b) => {
					const orderA = ordering.get(a.path) ?? Infinity;
					const orderB = ordering.get(b.path) ?? Infinity;
					return orderA - orderB;
				});
			}
		}
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
	 * Calculate the maximum content height needed across all four quadrants
	 */
	private calculateMaxQuadrantHeight(taskCounts: Record<string, number>): number {
		const headerHeight = 50; // Approximate header height
		const quadrantIds: Quadrant[] = [
			"urgent-important",
			"not-urgent-important",
			"urgent-not-important",
			"not-urgent-not-important"
		];
		
		// Approximate height per task card: ~45px card + 8px gap = ~53px
		const estimatedCardHeight = 53;
		
		let maxContentHeight = 0;
		
		for (const quadrantId of quadrantIds) {
			const taskCount = taskCounts[quadrantId] || 0;
			const usesVirtualScrolling = taskCount >= this.VIRTUAL_SCROLL_THRESHOLD;
			
			if (usesVirtualScrolling) {
				// For virtual scrolling, estimate height based on task count
				// Add padding (8px top + 8px bottom = 16px)
				const estimatedHeight = (taskCount * estimatedCardHeight) + 16;
				maxContentHeight = Math.max(maxContentHeight, estimatedHeight);
			} else {
				// For normal rendering, measure actual content height
				const quadrant = this.matrixContainer?.querySelector(
					`.eisenhower-matrix__quadrant--${quadrantId}`
				) as HTMLElement;
				
				if (quadrant) {
					const tasksContainer = quadrant.querySelector(
						".eisenhower-matrix__quadrant-tasks"
					) as HTMLElement;
					
					if (tasksContainer) {
						// Temporarily set overflow to visible to measure full content height
						const originalOverflow = tasksContainer.style.overflowY;
						tasksContainer.style.overflowY = "visible";
						
						// Measure the scroll height (full content height)
						const contentHeight = tasksContainer.scrollHeight;
						maxContentHeight = Math.max(maxContentHeight, contentHeight);
						
						// Restore original overflow
						tasksContainer.style.overflowY = originalOverflow;
					}
				}
			}
		}
		
		// Ensure minimum height (at least show a few tasks)
		const minContentHeight = (3 * estimatedCardHeight) + 16; // 3 tasks minimum
		maxContentHeight = Math.max(maxContentHeight, minContentHeight);
		
		// Return total height: content + header
		return maxContentHeight + headerHeight;
	}
	
	/**
	 * Apply uniform height to all four quadrants
	 */
	private applyUniformHeightToQuadrants(height: number): void {
		const quadrantIds: Quadrant[] = [
			"urgent-important",
			"not-urgent-important",
			"urgent-not-important",
			"not-urgent-not-important"
		];
		
		const headerHeight = 50;
		const tasksContainerHeight = height - headerHeight;
		
		for (const quadrantId of quadrantIds) {
			const quadrant = this.matrixContainer?.querySelector(
				`.eisenhower-matrix__quadrant--${quadrantId}`
			) as HTMLElement;
			
			if (quadrant) {
				// Set quadrant height
				quadrant.style.height = `${height}px`;
				
				// Update tasks container height
				const tasksContainer = quadrant.querySelector(
					".eisenhower-matrix__quadrant-tasks"
				) as HTMLElement;
				
				if (tasksContainer) {
					tasksContainer.style.height = `${tasksContainerHeight}px`;
					tasksContainer.style.overflowY = "auto";
					
					// Update background label position if it exists
					const label = quadrant.querySelector(
						".eisenhower-matrix__background-label"
					) as HTMLElement;
					
					if (label) {
						const availableHeight = height - headerHeight;
						const tasksAreaCenter = headerHeight + (availableHeight / 2);
						label.style.top = `${tasksAreaCenter}px`;
					}
				}
			}
		}
	}

	/**
	 * Render a single quadrant
	 */
	private renderQuadrant(quadrantId: Quadrant, tasks: TaskInfo[], title: string, backgroundLabel?: string, useAutoHeight: boolean = false, isCollapsible: boolean = false): void {
		if (!this.matrixContainer) return;

		const quadrant = document.createElement("div");
		quadrant.className = `eisenhower-matrix__quadrant eisenhower-matrix__quadrant--${quadrantId}`;
		
		// Base styles for all quadrants
		// Use auto height initially for measurement, then apply uniform height later
		const initialHeight = useAutoHeight ? "auto" : (quadrantId === "holding-pen" ? `${this.QUADRANT_FIXED_HEIGHT}px` : `${this.QUADRANT_FIXED_HEIGHT}px`);
		let quadrantStyle = `
			display: flex;
			flex-direction: column;
			border: 2px solid var(--background-modifier-border);
			border-radius: 8px;
			background: var(--background-secondary);
			overflow: hidden;
			height: ${initialHeight};
			flex-shrink: 0;
			position: relative;
		`;
		
		// Special styling for uncategorized and excluded regions (spans full width)
		if (quadrantId === "holding-pen" || quadrantId === "excluded") {
			quadrantStyle += `grid-column: 1 / -1;`;
		}
		
		quadrant.style.cssText = quadrantStyle;
		
		// Add background label if provided
		if (backgroundLabel) {
			const label = document.createElement("div");
			label.className = "eisenhower-matrix__background-label";
			label.textContent = backgroundLabel;
			// For auto height, we'll position it later after height is calculated
			// For now, use a temporary position that will be updated
			const headerHeight = 50;
			const tempHeight = useAutoHeight ? 300 : this.QUADRANT_FIXED_HEIGHT; // Temporary estimate for auto height
			const availableHeight = tempHeight - headerHeight;
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
		
		// Add collapsible toggle if needed
		if (isCollapsible) {
			const toggle = document.createElement("div");
			toggle.className = "eisenhower-matrix__quadrant-toggle";
			toggle.style.cssText = `
				cursor: pointer;
				user-select: none;
				margin-right: 8px;
				display: flex;
				align-items: center;
				justify-content: center;
				width: 20px;
				height: 20px;
				flex-shrink: 0;
			`;
			toggle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l3 3-3 3"/></svg>`;
			
			let isCollapsed = false;
			
			toggle.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				isCollapsed = !isCollapsed;
				quadrant.classList.toggle("eisenhower-matrix__quadrant--collapsed", isCollapsed);
				toggle.style.transform = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";
				
				// Get header height for collapsed state
				const header = quadrant.querySelector(".eisenhower-matrix__quadrant-header") as HTMLElement;
				if (!header) return;
				
				if (isCollapsed) {
					// Collapse to header height
					const headerHeight = header.offsetHeight;
					// Store current height before collapsing
					const currentHeight = quadrant.offsetHeight;
					(quadrant as any).__originalHeight = currentHeight;
					quadrant.style.height = `${headerHeight}px`;
				} else {
					// Restore to original height (stored or default)
					const storedHeight = (quadrant as any).__originalHeight;
					const restoreHeight = storedHeight || 
						(quadrantId === "holding-pen" || quadrantId === "excluded" 
							? this.QUADRANT_FIXED_HEIGHT 
							: this.QUADRANT_FIXED_HEIGHT);
					quadrant.style.height = `${restoreHeight}px`;
				}
			});
			
			header.appendChild(toggle);
		}
		
		header.createSpan({ text: title });
		const count = header.createSpan({
			text: `(${tasks.length})`,
			cls: "eisenhower-matrix__quadrant-count",
		});
		count.style.cssText = "font-weight: normal; color: var(--text-muted); font-size: 12px;";
		quadrant.appendChild(header);

		// Tasks container - height depends on whether we're measuring or using fixed height
		const tasksContainer = document.createElement("div");
		tasksContainer.className = "eisenhower-matrix__quadrant-tasks";
		const headerHeight = 50;
		
		// For holding-pen, use fixed height. For others, use auto if measuring, otherwise fixed
		let tasksContainerHeight: string;
		let overflowSetting: string;
		
		if (quadrantId === "holding-pen" || quadrantId === "excluded") {
			// Holding pen and excluded always use fixed height with scrolling
			tasksContainerHeight = `${this.QUADRANT_FIXED_HEIGHT - headerHeight}px`;
			overflowSetting = "auto";
		} else if (useAutoHeight) {
			// Use auto height for initial measurement
			tasksContainerHeight = "auto";
			overflowSetting = "visible";
		} else {
			// Will be set later by applyUniformHeightToQuadrants
			tasksContainerHeight = `${this.QUADRANT_FIXED_HEIGHT - headerHeight}px`;
			overflowSetting = "auto";
		}
		
		tasksContainer.style.cssText = `
			height: ${tasksContainerHeight};
			overflow-y: ${overflowSetting};
			padding: 8px;
			display: flex;
			flex-direction: column;
			gap: 2px;
			flex-shrink: 0;
			position: relative;
			z-index: 1;
		`;

		// Render task cards
		const visibleProperties = this.getVisibleProperties();
		const cardOptions = this.getCardOptions();

		if (tasks.length === 0) {
			// Add drop zone for empty quadrant
			this.createDropZone(tasksContainer, quadrantId, null, 0);
			
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
			// Render normally for smaller quadrants with drop zones
			// Add drop zone at the beginning
			this.createDropZone(tasksContainer, quadrantId, null, 0);
			
			for (let i = 0; i < tasks.length; i++) {
				const task = tasks[i];
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
					this.setupCardDragHandlers(cardWrapper, task, quadrantId);
					
					// Add drop zone after this task (before the next one)
					this.createDropZone(tasksContainer, quadrantId, task.path, i + 1);
				} catch (error) {
					console.error(`[TaskNotes][EisenhowerMatrixView] Error creating card for ${task.path}:`, error);
					// Continue with next task instead of crashing
				}
			}
		}
		
		// Setup drop handlers for the quadrant
		this.setupQuadrantDropHandlers(quadrant, quadrantId);
		
		// Also set up drop handlers on tasks container for excluded and holding-pen
		// to ensure drops are caught even when dropping on empty areas
		// Only handle drops INTO these quadrants, not FROM them
		if (quadrantId === "excluded" || quadrantId === "holding-pen") {
			// Set up a separate handler for the tasks container that only handles drops INTO this quadrant
			tasksContainer.addEventListener("dragover", (e: DragEvent) => {
				// Only allow dragover if dragging FROM a different quadrant
				// AND we're actually over this tasks container (not just bubbling through)
				if (this.draggedFromQuadrant && 
				    this.draggedFromQuadrant !== quadrantId &&
				    tasksContainer.contains(e.target as Node)) {
					e.preventDefault();
					// Don't stop propagation - let quadrant handler also see it
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
					quadrant.classList.add("eisenhower-matrix__quadrant--dragover");
				}
				// For same-quadrant or no quadrant, don't prevent - let it bubble
			});
			
			tasksContainer.addEventListener("drop", async (e: DragEvent) => {
				// Only handle if dragging FROM a different quadrant
				// AND we're actually dropping on this tasks container or its children
				const target = e.target as HTMLElement;
				const isWithinContainer = target && (
					target === tasksContainer || 
					tasksContainer.contains(target) ||
					target.closest('.eisenhower-matrix__quadrant-tasks') === tasksContainer
				);
				
				if (this.draggedFromQuadrant && 
				    this.draggedFromQuadrant !== quadrantId && 
				    this.draggedTaskPath &&
				    isWithinContainer) {
					e.preventDefault();
					e.stopPropagation(); // Stop here to prevent quadrant handler from also handling
					quadrant.classList.remove("eisenhower-matrix__quadrant--dragover");
					
					// Store the task path before clearing it
					const taskPath = this.draggedTaskPath;
					const fromQuadrant = this.draggedFromQuadrant;
					
					// Clear immediately to prevent double handling
					this.draggedTaskPath = null;
					this.draggedFromQuadrant = null;
					
					// Update tags based on target quadrant
					await this.handleTaskDrop(taskPath, quadrantId);
					return; // Explicitly return to prevent further processing
				}
				// For same-quadrant drops or no valid drag, don't prevent - let it bubble
			});
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

	private createVirtualQuadrant(
		tasksContainer: HTMLElement,
		quadrantId: Quadrant,
		tasks: TaskInfo[],
		visibleProperties: string[],
		cardOptions: any
	): void {
		// Container height is already set by renderQuadrant, just ensure it's scrollable
		// For virtual scrolling, we still need to set a height
		// This will be updated by applyUniformHeightToQuadrants if needed
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
					this.setupCardDragHandlers(cardWrapper, task, quadrantId);
					
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

	/**
	 * Create a drop zone element for reordering tasks
	 */
	private createDropZone(container: HTMLElement, quadrantId: Quadrant, afterTaskPath: string | null, insertIndex: number): void {
		const dropZone = document.createElement("div");
		dropZone.className = "eisenhower-matrix__drop-zone";
		dropZone.setAttribute("data-quadrant-id", quadrantId);
		dropZone.setAttribute("data-insert-index", insertIndex.toString());
		if (afterTaskPath) {
			dropZone.setAttribute("data-after-task", afterTaskPath);
		}
		
		dropZone.style.cssText = `
			min-height: 4px;
			margin: 2px 0;
			border-radius: 2px;
			transition: all 0.2s ease;
		`;

		// Setup drop zone handlers
		dropZone.addEventListener("dragover", (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId) {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				dropZone.classList.add("eisenhower-matrix__drop-zone--active");
			}
			// For cross-quadrant drags, don't prevent - let it bubble to quadrant handler
		});

		dropZone.addEventListener("dragleave", () => {
			dropZone.classList.remove("eisenhower-matrix__drop-zone--active");
		});

		dropZone.addEventListener("drop", async (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId) {
				e.preventDefault();
				e.stopPropagation();
				dropZone.classList.remove("eisenhower-matrix__drop-zone--active");
				
				// Determine the target task path for insertion
				// If afterTaskPath is null, insert at beginning
				// Otherwise, insert after the specified task
				const targetTaskPath = afterTaskPath || null;
				await this.handleTaskReorderToIndex(this.draggedTaskPath, quadrantId, insertIndex);
			}
			// For cross-quadrant drops, don't prevent - let it bubble to quadrant handler
		});

		container.appendChild(dropZone);
	}

	private setupCardDragHandlers(cardWrapper: HTMLElement, task: TaskInfo, quadrantId: Quadrant): void {
		cardWrapper.addEventListener("dragstart", (e: DragEvent) => {
			this.draggedTaskPath = task.path;
			this.draggedFromQuadrant = quadrantId;
			cardWrapper.classList.add("eisenhower-matrix__card--dragging");

			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", task.path);
				e.dataTransfer.setData("text/x-quadrant-id", quadrantId);
			}
		});

		cardWrapper.addEventListener("dragend", () => {
			cardWrapper.classList.remove("eisenhower-matrix__card--dragging");

			// Clean up any lingering dragover classes
			this.matrixContainer?.querySelectorAll('.eisenhower-matrix__quadrant--dragover').forEach(el => {
				el.classList.remove('eisenhower-matrix__quadrant--dragover');
			});
			this.matrixContainer?.querySelectorAll('.eisenhower-matrix__card-wrapper--dragover').forEach(el => {
				el.classList.remove('eisenhower-matrix__card-wrapper--dragover');
			});
			this.matrixContainer?.querySelectorAll('.eisenhower-matrix__drop-zone--active').forEach(el => {
				el.classList.remove('eisenhower-matrix__drop-zone--active');
			});
			
			this.draggedTaskPath = null;
			this.draggedFromQuadrant = null;
		});

		// Add drop handlers for within-quadrant reordering
		cardWrapper.addEventListener("dragover", (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId && this.draggedTaskPath !== task.path) {
				e.preventDefault();
				e.stopPropagation();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				
				// Determine if dropping above or below based on mouse position
				const rect = cardWrapper.getBoundingClientRect();
				const midpoint = rect.top + rect.height / 2;
				const insertBefore = e.clientY < midpoint;
				
				cardWrapper.classList.add("eisenhower-matrix__card-wrapper--dragover");
				cardWrapper.setAttribute("data-insert-before", insertBefore.toString());
			}
			// For cross-quadrant drags, don't prevent default or stop propagation
			// Let the event bubble up to the quadrant's dragover handler
		});

		cardWrapper.addEventListener("dragleave", () => {
			cardWrapper.classList.remove("eisenhower-matrix__card-wrapper--dragover");
			cardWrapper.removeAttribute("data-insert-before");
		});

		cardWrapper.addEventListener("drop", async (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId && this.draggedTaskPath !== task.path) {
				e.preventDefault();
				e.stopPropagation();
				cardWrapper.classList.remove("eisenhower-matrix__card-wrapper--dragover");
				
				const insertBefore = cardWrapper.getAttribute("data-insert-before") === "true";
				cardWrapper.removeAttribute("data-insert-before");
				
				await this.handleTaskReorder(this.draggedTaskPath, task.path, quadrantId, insertBefore);
				return; // Explicitly return to prevent further processing
			}
			// For cross-quadrant drops, don't prevent default or stop propagation
			// Let the event bubble up to the quadrant's drop handler
		});
	}

	private setupQuadrantDropHandlers(quadrant: HTMLElement, quadrantId: Quadrant): void {
		// Drag over handler - must always prevent default for drops to work
		quadrant.addEventListener("dragover", (e: DragEvent) => {
			// Always prevent default if we have a drag in progress (required for drop to work)
			if (this.draggedTaskPath) {
				// Only show visual feedback if dragging from a different quadrant
				if (!this.draggedFromQuadrant || this.draggedFromQuadrant !== quadrantId) {
					e.preventDefault();
					e.stopPropagation();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
					quadrant.classList.add("eisenhower-matrix__quadrant--dragover");
				} else {
					// Same quadrant - still prevent default but don't show visual feedback
					// (card handlers will handle the visual feedback)
					e.preventDefault();
				}
			}
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

		// Drop handler - only handles cross-quadrant moves
		// Use capture phase to catch drops before child handlers
		quadrant.addEventListener("drop", async (e: DragEvent) => {
			// Don't handle if this is a same-quadrant drop (handled by card drop handler)
			if (this.draggedFromQuadrant === quadrantId) {
				return;
			}

			// If draggedTaskPath is null, it was already handled by a tasks container handler
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			quadrant.classList.remove("eisenhower-matrix__quadrant--dragover");

			// Update tags based on target quadrant
			const taskPath = this.draggedTaskPath;
			const fromQuadrant = this.draggedFromQuadrant;
			
			// Clear immediately to prevent double handling
			this.draggedTaskPath = null;
			this.draggedFromQuadrant = null;
			
			await this.handleTaskDrop(taskPath, quadrantId);
		}, true); // Use capture phase
	}

	private async handleTaskReorderToIndex(draggedTaskPath: string, quadrantId: Quadrant, targetIndex: number): Promise<void> {
		try {
			// Get current ordering for this quadrant
			let ordering = this.quadrantOrderings.get(quadrantId);
			if (!ordering) {
				ordering = new Map();
				this.quadrantOrderings.set(quadrantId, ordering);
			}

			// Get all tasks in this quadrant to determine current positions
			const tasksContainer = this.matrixContainer?.querySelector(
				`.eisenhower-matrix__quadrant--${quadrantId} .eisenhower-matrix__quadrant-tasks`
			);
			if (!tasksContainer) return;

			// Get only task cards (not drop zones)
			const cardWrappers = Array.from(tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper'));
			const taskPaths = cardWrappers.map(wrapper => 
				(wrapper as HTMLElement).getAttribute('data-task-path')
			).filter(Boolean) as string[];

			// Find current index of dragged task
			const draggedIndex = taskPaths.indexOf(draggedTaskPath);
			if (draggedIndex === -1) return;

			// Calculate new order values
			// Remove dragged task from its position
			taskPaths.splice(draggedIndex, 1);
			
			// Adjust target index if dragging down (since we removed the item)
			let insertIndex = targetIndex;
			if (draggedIndex < targetIndex) {
				insertIndex = targetIndex - 1;
			}
			
			// Clamp insert index to valid range
			insertIndex = Math.max(0, Math.min(insertIndex, taskPaths.length));
			
			// Insert at calculated position
			taskPaths.splice(insertIndex, 0, draggedTaskPath);

			// Update ordering map with new positions
			taskPaths.forEach((path, index) => {
				ordering!.set(path, index);
			});

			// Save ordering
			this.saveQuadrantOrderings();

			// Refresh to show updated order
			this.debouncedRefresh();
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error reordering task:", error);
		}
	}

	private async handleTaskReorder(draggedTaskPath: string, targetTaskPath: string, quadrantId: Quadrant, insertBefore: boolean): Promise<void> {
		try {
			// Get current ordering for this quadrant
			let ordering = this.quadrantOrderings.get(quadrantId);
			if (!ordering) {
				ordering = new Map();
				this.quadrantOrderings.set(quadrantId, ordering);
			}

			// Get all tasks in this quadrant to determine current positions
			const tasksContainer = this.matrixContainer?.querySelector(
				`.eisenhower-matrix__quadrant--${quadrantId} .eisenhower-matrix__quadrant-tasks`
			);
			if (!tasksContainer) return;

			const cardWrappers = Array.from(tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper'));
			const taskPaths = cardWrappers.map(wrapper => 
				(wrapper as HTMLElement).getAttribute('data-task-path')
			).filter(Boolean) as string[];

			// Find current indices
			const draggedIndex = taskPaths.indexOf(draggedTaskPath);
			const targetIndex = taskPaths.indexOf(targetTaskPath);

			if (draggedIndex === -1 || targetIndex === -1) return;

			// Calculate new order values
			// Remove dragged task from its position
			taskPaths.splice(draggedIndex, 1);
			
			// Calculate insert position
			let insertIndex = targetIndex;
			if (draggedIndex < targetIndex) {
				// Moving down: target index is already adjusted by removal
				insertIndex = insertBefore ? targetIndex - 1 : targetIndex;
			} else {
				// Moving up: target index is unchanged
				insertIndex = insertBefore ? targetIndex : targetIndex + 1;
			}
			
			// Insert at calculated position
			taskPaths.splice(insertIndex, 0, draggedTaskPath);

			// Update ordering map with new positions
			taskPaths.forEach((path, index) => {
				ordering!.set(path, index);
			});

			// Save ordering
			this.saveQuadrantOrderings();

			// Refresh to show updated order
			this.debouncedRefresh();
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error reordering task:", error);
		}
	}

	private async handleTaskDrop(taskPath: string, targetQuadrant: Quadrant): Promise<void> {
		// Check if this is a same-quadrant drop (should be handled by handleTaskReorder instead)
		if (this.draggedFromQuadrant === targetQuadrant) {
			// Same quadrant drops are handled by card drop handlers
			return;
		}

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

			// Clear ordering for the old quadrant and assign new order in target quadrant
			if (this.draggedFromQuadrant) {
				const oldOrdering = this.quadrantOrderings.get(this.draggedFromQuadrant);
				if (oldOrdering) {
					oldOrdering.delete(taskPath);
					this.saveQuadrantOrderings();
				}
			}

			// Add to end of target quadrant's ordering
			let targetOrdering = this.quadrantOrderings.get(targetQuadrant);
			if (!targetOrdering) {
				targetOrdering = new Map();
				this.quadrantOrderings.set(targetQuadrant, targetOrdering);
			}
			// Get max order value and add 1
			const maxOrder = targetOrdering.size > 0 
				? Math.max(...Array.from(targetOrdering.values()))
				: -1;
			targetOrdering.set(taskPath, maxOrder + 1);
			this.saveQuadrantOrderings();

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
		const tagExcluded = "excluded";

		// Build new tags array
		const newTags: string[] = [];
		
		// Keep all existing tags except the four eisenhower tags and excluded tag (we'll add them back if needed)
		for (const tag of currentTags) {
			const normalized = tag.toLowerCase();
			if (
				normalized !== tagYUrgent.toLowerCase() &&
				normalized !== tagNUrgent.toLowerCase() &&
				normalized !== tagYImportant.toLowerCase() &&
				normalized !== tagNImportant.toLowerCase() &&
				normalized !== tagExcluded.toLowerCase()
			) {
				newTags.push(tag); // Keep original case
			}
		}

		// Add tags based on target quadrant - use all 4 tags to be explicit
		if (targetQuadrant === "holding-pen") {
			// Remove all eisenhower tags and excluded tag (already filtered above)
			// Don't add any tags - task remains uncategorized
		} else if (targetQuadrant === "excluded") {
			// Remove all eisenhower tags (already filtered above)
			// Add excluded tag
			newTags.push(tagExcluded);
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

