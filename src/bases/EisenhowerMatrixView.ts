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
	 * Fixed height for quadrants: 350px content + 50px header = 400px total
	 */
	private readonly QUADRANT_FIXED_HEIGHT = 400; // pixels (350px content + 50px header)
	/**
	 * Fixed height for uncategorized and excluded regions: 200px total (150px content + 50px header)
	 */
	private readonly UNCATEGORIZED_FIXED_HEIGHT = 200; // pixels (150px content + 50px header)
	private draggedTaskPath: string | null = null;
	private draggedFromQuadrant: Quadrant | null = null;
	private quadrantOrderings: Map<Quadrant, Map<string, number>> = new Map();
	private collapsedSections: Set<Quadrant> = new Set(); // Track collapsed sections (holding-pen, excluded)
	private isUnloading = false; // Flag to prevent multiple save attempts during unload
	
	// Track all event listeners for proper cleanup
	private eventListeners: Array<{ element: HTMLElement; event: string; handler: EventListener }> = [];
	// Track all timers for proper cleanup
	private activeTimers: Set<number> = new Set();
	
	/**
	 * Helper to track and add event listeners for cleanup
	 */
	private addTrackedEventListener(element: HTMLElement, event: string, handler: EventListener, options?: boolean | AddEventListenerOptions): void {
		element.addEventListener(event, handler, options);
		this.eventListeners.push({ element, event, handler });
	}
	
	/**
	 * Helper to track setTimeout calls for cleanup
	 */
	private trackedSetTimeout(callback: () => void, delay: number): number {
		const timerId = window.setTimeout(() => {
			this.activeTimers.delete(timerId);
			callback();
		}, delay);
		this.activeTimers.add(timerId);
		return timerId;
	}
	
	// Instance-based flags (not static to avoid cross-instance interference)
	// Each view instance has its own flags to prevent multiple views from interfering
	private lastSelectiveUpdateTime: number = 0;
	private skipDataUpdateCount: number = 0;
	private static readonly SELECTIVE_UPDATE_WINDOW_MS = 3000; // 3 second window
	
	// Instance properties (may be lost if view is recreated)
	private justDidSelectiveUpdate = false; // Flag to skip onDataUpdated() if we just updated UI selectively
	private skipNextDataUpdate = false; // Additional flag to skip the very next onDataUpdated() call
	private _isFirstDataUpdate = true; // Track first data update for immediate render
	private _isRendering = false; // Prevent concurrent renders
	private _pendingRender = false; // Track if render was requested while rendering
	private _lastDataHash: string | null = null; // Hash of last rendered data to skip unnecessary renders
	private _orderingsLoaded = false; // Track if orderings have been loaded
	private _collapsedStateLoaded = false; // Track if collapsed state has been loaded
	private _lastRenderTime = 0; // Track last render time for throttling
	private _throttleTimer: number | null = null; // Track throttle timer to cancel on unload
	private _initialRenderComplete = false; // Track if initial render has completed
	private _initialRenderCooldown = 0; // Cooldown period after initial render to prevent immediate re-renders
	private _renderBlocked = false; // Block all renders during stabilization period
	private _viewInstanceId: string; // Unique ID for this view instance to prevent cross-instance issues
	private _onDataUpdatedCallCount = 0; // Track rapid successive calls
	private _onDataUpdatedCallResetTimer: number | null = null; // Timer to reset call count
	private static readonly MIN_RENDER_INTERVAL_MS = 10000; // Minimum 10 seconds between renders (throttle) - very aggressive
	private static readonly INITIAL_RENDER_COOLDOWN_MS = 30000; // 30 second cooldown after initial render - very long
	private static readonly MAX_ON_DATA_UPDATED_CALLS_PER_SECOND = 2; // Max 2 calls per second

	constructor(controller: any, containerEl: HTMLElement, plugin: TaskNotesPlugin) {
		super(controller, containerEl, plugin);
		// Generate unique ID for this view instance
		this._viewInstanceId = `eisenhower-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
		// Skip rendering if view is unloading (prevents renders during file switches)
		if (this.isUnloading) {
			return;
		}
		
		// AGGRESSIVE: Block all renders during initial stabilization period
		// This prevents the matrix from disappearing due to rapid re-renders
		if (this._renderBlocked) {
			return;
		}
		
		// CRITICAL: Verify this render is for the correct container
		// Prevent renders from affecting wrong view instances
		if (!this.containerEl || !this.containerEl.isConnected) {
			return;
		}
		
		// Skip rendering if view is not visible (saves CPU for background tabs)
		if (!this.isViewVisible()) {
			return;
		}
		
		// Prevent duplicate concurrent renders
		if (this._isRendering) {
			this._pendingRender = true;
			return;
		}

		this._isRendering = true;
		this._pendingRender = false;

		if (!this.rootElement) {
			this._isRendering = false;
			return;
		}
		
		// CRITICAL: Verify rootElement belongs to this container
		if (!this.containerEl.contains(this.rootElement)) {
			this._isRendering = false;
			return;
		}
		
		if (!this.matrixContainer) {
			// Container not set up yet, try to set it up
			this.setupContainer();
		}
		if (!this.matrixContainer) {
			this._isRendering = false;
			return;
		}
		
		// CRITICAL: Verify matrixContainer belongs to this rootElement
		if (!this.rootElement.contains(this.matrixContainer)) {
			// Matrix container is orphaned, recreate it
			this.setupContainer();
			if (!this.matrixContainer || !this.rootElement.contains(this.matrixContainer)) {
				this._isRendering = false;
				return;
			}
		}
		if (!this.data) {
			this._isRendering = false;
			return;
		}
		if (!this.data.data || !Array.isArray(this.data.data)) {
			// Data not ready yet
			this._isRendering = false;
			return;
		}

		try {
			// Use requestAnimationFrame to yield to browser and prevent blocking
			// This prevents the UI from freezing during heavy operations
			await new Promise(resolve => requestAnimationFrame(resolve));
			
			// Check again after yielding - view might have been unloaded
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			const dataItems = this.dataAdapter.extractDataItems();
			if (!dataItems || dataItems.length === 0) {
				this.renderEmptyState();
				this._isRendering = false;
				return;
			}
			
			// Create a simple hash of the data to detect if it actually changed
			// This prevents unnecessary full rebuilds when data hasn't changed
			const dataHash = this.createDataHash(dataItems);
			if (dataHash === this._lastDataHash && this._lastDataHash !== null) {
				// Data hasn't changed, skip render
				// BUT: if matrix is empty, we need to render anyway (recovery case)
				if (this.matrixContainer && this.matrixContainer.children.length > 0) {
					this._isRendering = false;
					return;
				}
				// Matrix is empty, force a render even if data hash is same
			}
			this._lastDataHash = dataHash;
			
			// Throttle renders to prevent too frequent updates
			const now = Date.now();
			const timeSinceLastRender = now - this._lastRenderTime;
			if (timeSinceLastRender < EisenhowerMatrixView.MIN_RENDER_INTERVAL_MS && this._lastRenderTime > 0) {
				// Too soon since last render, schedule for later
				this._isRendering = false;
				// Cancel any existing throttle timer
				if (this._throttleTimer !== null) {
					clearTimeout(this._throttleTimer);
				}
				this._throttleTimer = this.trackedSetTimeout(() => {
					this._throttleTimer = null;
					if (!this.isUnloading && this.isViewVisible()) {
						this.render();
					}
				}, EisenhowerMatrixView.MIN_RENDER_INTERVAL_MS - timeSinceLastRender);
				return;
			}
			this._lastRenderTime = now;
			
			// Yield again before heavy data processing
			await new Promise(resolve => requestAnimationFrame(resolve));
			
			// Check again after yielding
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			// Process data items in batches with yields to prevent blocking
			// This prevents the UI from freezing when processing many tasks
			const taskNotes: TaskInfo[] = [];
			const BATCH_SIZE = 50; // Process 50 items at a time
			for (let i = 0; i < dataItems.length; i += BATCH_SIZE) {
				// Check if we should abort before each batch
				if (this.isUnloading || !this.isViewVisible() || this._renderBlocked) {
					this._isRendering = false;
					return;
				}
				
				const batch = dataItems.slice(i, i + BATCH_SIZE);
				const batchTasks = await identifyTaskNotesFromBasesData(batch, this.plugin);
				taskNotes.push(...batchTasks);
				
				// Yield after each batch to keep UI responsive
				if (i + BATCH_SIZE < dataItems.length) {
					await new Promise(resolve => requestAnimationFrame(resolve));
				}
			}
			
			// Check again after async operation - view might have been unloaded
			if (this.isUnloading || !this.isViewVisible() || this._renderBlocked) {
				this._isRendering = false;
				return;
			}

			// Clean up existing scrollers
			this.destroyQuadrantScrollers();
			
			// Only clear matrix if we're actually going to render new content
			// Don't clear if we're just going to exit early
			if (taskNotes.length === 0) {
				// Only clear if we need to show empty state
				this.matrixContainer.empty();
				this.renderEmptyState();
				this._isRendering = false;
				return;
			}
			
			// CRITICAL: Never clear matrix during cooldown period if it has content
			// This is the most important check to prevent disappearing
			const inCooldown = this._initialRenderComplete && this._initialRenderCooldown > Date.now();
			if (inCooldown && this.matrixContainer && this.matrixContainer.children.length > 0) {
				// In cooldown and matrix has content - DO NOT CLEAR, just exit
				// This prevents the matrix from disappearing no matter what
				this._isRendering = false;
				return;
			}
			
			// Additional safety: If matrix has content and we're blocked, don't clear
			if (this._renderBlocked && this.matrixContainer && this.matrixContainer.children.length > 0) {
				this._isRendering = false;
				return;
			}
			
			// Now clear matrix since we know we're going to render
			// But only if we're not in cooldown/blocked state
			if (!inCooldown && !this._renderBlocked) {
				this.matrixContainer.empty();
			} else {
				// We're in cooldown/blocked - don't clear, just exit
				this._isRendering = false;
				return;
			}

			// Load quadrant orderings from config (only once, then cache)
			if (!this._orderingsLoaded) {
				this.loadQuadrantOrderings();
				this._orderingsLoaded = true;
			}
			
			// Load collapsed state (only once, then cache)
			if (!this._collapsedStateLoaded) {
				this.loadCollapsedState();
				this._collapsedStateLoaded = true;
			}

			// Yield before heavy categorization
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			// Categorize tasks into quadrants
			const quadrants = this.categorizeTasks(taskNotes);

			// Apply custom ordering to each quadrant's tasks
			this.applyOrderingToQuadrants(quadrants);

			// Yield before rendering quadrants
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}

			// Render each quadrant - top row: Important quadrants, bottom row: Not Important quadrants
			// All use fixed height (400px total: 350px content + 50px header) set directly in renderQuadrant
			// Render quadrants one at a time with yields to prevent blocking
			this.renderQuadrant("urgent-important", quadrants.urgentImportant, "Urgent / Important", "DO", false);
			
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			this.renderQuadrant("not-urgent-important", quadrants.notUrgentImportant, "Not Urgent / Important", "DECIDE", false);
			
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			this.renderQuadrant("urgent-not-important", quadrants.urgentNotImportant, "Urgent / Not Important", "DELEGATE", false);
			
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			this.renderQuadrant("not-urgent-not-important", quadrants.notUrgentNotImportant, "Not Urgent / Not Important", "DEFER", false);
			
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			// Render uncategorized region (spans full width below the matrix) - fixed height
			this.renderQuadrant("holding-pen", quadrants.holdingPen, "Uncategorized", undefined, false, true);
			
			await new Promise(resolve => requestAnimationFrame(resolve));
			if (this.isUnloading || !this.isViewVisible()) {
				this._isRendering = false;
				return;
			}
			
			// Render excluded region (spans full width below uncategorized) - fixed height
			this.renderQuadrant("excluded", quadrants.excluded, "Excluded", undefined, false, true);
		} catch (error: any) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error rendering:", error);
			// If matrix was cleared but render failed, try to restore previous state
			// by triggering a re-render after a short delay
			if (this.matrixContainer && this.matrixContainer.children.length === 0) {
				// Matrix was cleared but render failed - schedule a recovery render
				this.trackedSetTimeout(() => {
					if (!this.isUnloading && this.isViewVisible() && this.matrixContainer?.children.length === 0) {
						// Force a re-render by clearing the data hash
						this._lastDataHash = null;
						this.render();
					}
				}, 1000);
			}
			this.renderError(error);
		} finally {
			this._isRendering = false;
			
			// Mark initial render as complete and set cooldown only if render succeeded
			// Check if matrix actually has content
			if (!this._initialRenderComplete && this.matrixContainer && this.matrixContainer.children.length > 0) {
				this._initialRenderComplete = true;
				this._initialRenderCooldown = Date.now() + EisenhowerMatrixView.INITIAL_RENDER_COOLDOWN_MS;
				
				// AGGRESSIVE: Block all renders for the cooldown period to prevent disappearing
				this._renderBlocked = true;
				this.trackedSetTimeout(() => {
					this._renderBlocked = false;
				}, EisenhowerMatrixView.INITIAL_RENDER_COOLDOWN_MS);
			}
		}

		// If a render was requested while we were rendering, do it now
		// But only if we're not unloading (prevents renders during file switches)
		if (this._pendingRender && !this.isUnloading) {
			this._pendingRender = false;
			// Use setTimeout to avoid deep call stack
			this.trackedSetTimeout(() => {
				if (!this.isUnloading && this.isViewVisible()) {
					this.render();
				}
			}, 0);
		}
	}

	/**
	 * Create a simple hash of data items to detect if data has changed.
	 * Uses paths only to avoid false positives from timestamp changes.
	 */
	private createDataHash(dataItems: any[]): string {
		if (!dataItems || dataItems.length === 0) {
			return 'empty';
		}
		
		// Create a simple hash based on paths and count only
		// Don't include timestamps as they can change without actual data changes
		// This prevents unnecessary re-renders when metadata updates but data is the same
		const paths = dataItems
			.map(item => item?.path || item?.file?.path || '')
			.filter(Boolean)
			.sort()
			.join('|');
		
		const count = dataItems.length;
		
		// Use a shorter hash to avoid memory issues with large datasets
		// Just use count and first 100 chars of paths
		return `${count}:${paths.substring(0, 100)}`;
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
	 * Load quadrant orderings from BasesViewConfig or localStorage fallback
	 */
	private loadQuadrantOrderings(): void {
		this.quadrantOrderings.clear();
		
		let orderingsJson: string | null = null;
		
		// Try to load from Bases config first
		try {
			orderingsJson = this.config?.get?.('quadrantOrderings');
		} catch (error) {
			console.warn('[EisenhowerMatrixView] Failed to load quadrant orderings from Bases config, trying localStorage:', error);
		}
		
		// Fallback to localStorage if config.get() failed or returned nothing
		if ((!orderingsJson || typeof orderingsJson !== 'string') && this.app) {
			try {
				const storageKey = `tasknotes-eisenhower-quadrant-orderings-${this.containerEl?.getAttribute('data-view-id') || 'default'}`;
				const stored = this.app.loadLocalStorage(storageKey);
				orderingsJson = (typeof stored === 'string' ? stored : null);
			} catch (localStorageError) {
				console.warn('[EisenhowerMatrixView] Failed to load quadrant orderings from localStorage:', localStorageError);
			}
		}
		
		// Parse and load the orderings
		if (orderingsJson && typeof orderingsJson === 'string') {
			try {
				const orderings = JSON.parse(orderingsJson);
				for (const [quadrantId, taskOrderMap] of Object.entries(orderings)) {
					if (typeof taskOrderMap === 'object' && taskOrderMap !== null) {
						this.quadrantOrderings.set(
							quadrantId as Quadrant,
							new Map(Object.entries(taskOrderMap as Record<string, number>))
						);
					}
				}
			} catch (parseError) {
				console.error('[EisenhowerMatrixView] Failed to parse quadrant orderings:', parseError);
			}
		}
	}

	/**
	 * Save quadrant orderings to BasesViewConfig
	 */
	/**
	 * Validate that data contains only plain serializable values (strings, numbers, booleans, arrays, plain objects)
	 * This helps prevent circular reference errors when saving to config
	 */
	private validateSerializable(data: any, path: string = 'root'): boolean {
		if (data === null || data === undefined) {
			return true;
		}
		const type = typeof data;
		if (type === 'string' || type === 'number' || type === 'boolean') {
			return true;
		}
		if (type === 'function' || type === 'symbol') {
			console.warn(`[EisenhowerMatrixView] Non-serializable ${type} found at ${path}`);
			return false;
		}
		if (Array.isArray(data)) {
			return data.every((item, index) => this.validateSerializable(item, `${path}[${index}]`));
		}
		if (type === 'object') {
			// Check for Map, Set, or other non-plain objects
			if (data instanceof Map || data instanceof Set || data instanceof Date || data instanceof RegExp) {
				console.warn(`[EisenhowerMatrixView] Non-serializable object type found at ${path}:`, data.constructor.name);
				return false;
			}
			// Check for circular references by validating all properties
			for (const key in data) {
				if (Object.prototype.hasOwnProperty.call(data, key)) {
					if (!this.validateSerializable(data[key], `${path}.${key}`)) {
						return false;
					}
				}
			}
			return true;
		}
		return false;
	}

	private saveQuadrantOrderings(): void {
		// CRITICAL: Skip save if we're unloading or container is disconnected
		// config.set() triggers onDataUpdated() on ALL instances, including new instances
		// This causes cascading renders when switching between notes (same tab or different tabs)
		if (this.isUnloading || !this.containerEl?.isConnected || !this.rootElement?.isConnected) {
			return;
		}
		
		// Mark as needing reload on next render
		this._orderingsLoaded = false;
		try {
			const orderings: Record<string, Record<string, number>> = {};
			for (const [quadrantId, taskOrderMap] of this.quadrantOrderings.entries()) {
				// Ensure we're only storing plain objects with string keys and number values
				if (taskOrderMap && taskOrderMap instanceof Map) {
					const plainObject: Record<string, number> = {};
					for (const [path, order] of taskOrderMap.entries()) {
						// Validate that path is a string and order is a number
						if (typeof path === 'string' && typeof order === 'number' && !isNaN(order)) {
							plainObject[path] = order;
						} else {
							console.warn(`[EisenhowerMatrixView] Skipping invalid ordering entry: path=${typeof path}, order=${typeof order}`);
						}
					}
					orderings[quadrantId] = plainObject;
				}
			}
			
			// Validate the data structure before stringifying
			if (!this.validateSerializable(orderings, 'orderings')) {
				console.error('[EisenhowerMatrixView] Orderings data contains non-serializable values, skipping save');
				return;
			}
			
			// Stringify with circular reference protection
			let orderingsJson: string;
			try {
				orderingsJson = JSON.stringify(orderings);
			} catch (stringifyError) {
				console.error('[EisenhowerMatrixView] Failed to stringify quadrant orderings:', stringifyError);
				return;
			}
			
			// CRITICAL: Only use localStorage during unload or when container is disconnected
			// config.set() triggers onDataUpdated() on ALL instances, causing cascading renders
			// When replacing a note in the same tab, Bases may reuse the view instance,
			// so config.set() would trigger updates on the new instance immediately
			let savedToConfig = false;
			if (!this.isUnloading && this.containerEl?.isConnected && this.rootElement?.isConnected &&
			    this.config && typeof this.config.set === 'function') {
				try {
					this.config.set('quadrantOrderings', orderingsJson);
					savedToConfig = true;
				} catch (setError: any) {
					// Check if it's a circular reference error - this is a known Bases issue
					// Silently fall back to localStorage without logging (to reduce console noise)
					const isCircularRef = setError?.message?.includes('circular') || setError?.message?.includes('Maximum call stack');
					if (!isCircularRef) {
						// Only log non-circular-reference errors
						console.warn('[EisenhowerMatrixView] Failed to save quadrant orderings to Bases config, falling back to localStorage:', setError);
					}
				}
			}
			
			// Fallback to localStorage if config.set() failed or isn't available
			if (!savedToConfig && this.app) {
				try {
					const storageKey = `tasknotes-eisenhower-quadrant-orderings-${this.containerEl?.getAttribute('data-view-id') || 'default'}`;
					this.app.saveLocalStorage(storageKey, orderingsJson);
				} catch (localStorageError) {
					console.error('[EisenhowerMatrixView] Failed to save quadrant orderings to localStorage:', localStorageError);
				}
			}
		} catch (error) {
			console.error('[EisenhowerMatrixView] Failed to save quadrant orderings:', error);
		}
	}

	/**
	 * Load collapsed state from BasesViewConfig or localStorage fallback
	 */
	private loadCollapsedState(): void {
		let collapsedJson: string | null = null;
		
		// Try to load from Bases config first
		try {
			collapsedJson = this.config?.get?.('collapsedSections');
		} catch (error) {
			console.warn('[EisenhowerMatrixView] Failed to load collapsed state from Bases config, trying localStorage:', error);
		}
		
		// Fallback to localStorage if config.get() failed or returned nothing
		if ((!collapsedJson || typeof collapsedJson !== 'string') && this.app) {
			try {
				const storageKey = `tasknotes-eisenhower-collapsed-sections-${this.containerEl?.getAttribute('data-view-id') || 'default'}`;
				const stored = this.app.loadLocalStorage(storageKey);
				collapsedJson = (typeof stored === 'string' ? stored : null);
			} catch (localStorageError) {
				console.warn('[EisenhowerMatrixView] Failed to load collapsed state from localStorage:', localStorageError);
			}
		}
		
		// Parse and load the collapsed state
		if (collapsedJson && typeof collapsedJson === 'string') {
			try {
				const collapsed: string[] = JSON.parse(collapsedJson);
				this.collapsedSections = new Set(collapsed as Quadrant[]);
			} catch (parseError) {
				console.error('[EisenhowerMatrixView] Failed to parse collapsed state:', parseError);
			}
		}
	}

	/**
	 * Save collapsed state to BasesViewConfig or localStorage fallback
	 */
	private saveCollapsedState(): void {
		// CRITICAL: Skip save if we're unloading or container is disconnected
		// config.set() triggers onDataUpdated() on ALL instances, including new instances
		// This causes cascading renders when switching between notes (same tab or different tabs)
		if (this.isUnloading || !this.containerEl?.isConnected || !this.rootElement?.isConnected) {
			return;
		}
		
		// Mark as needing reload on next render
		this._collapsedStateLoaded = false;
		try {
			// Convert Set to plain array of Quadrant strings, ensuring all are valid strings
			const collapsedArray = Array.from(this.collapsedSections).filter(
				(item): item is Quadrant => typeof item === 'string'
			);
			
			// Validate the data structure before stringifying
			if (!this.validateSerializable(collapsedArray, 'collapsedArray')) {
				console.error('[EisenhowerMatrixView] Collapsed state data contains non-serializable values, skipping save');
				return;
			}
			
			// Stringify with error handling
			let collapsedJson: string;
			try {
				collapsedJson = JSON.stringify(collapsedArray);
			} catch (stringifyError) {
				console.error('[EisenhowerMatrixView] Failed to stringify collapsed state:', stringifyError);
				return;
			}
			
			// CRITICAL: Only use localStorage during unload or when container is disconnected
			// config.set() triggers onDataUpdated() on ALL instances, causing cascading renders
			// When replacing a note in the same tab, Bases may reuse the view instance,
			// so config.set() would trigger updates on the new instance immediately
			let savedToConfig = false;
			if (!this.isUnloading && this.containerEl?.isConnected && this.rootElement?.isConnected &&
			    this.config && typeof this.config.set === 'function') {
				try {
					this.config.set('collapsedSections', collapsedJson);
					savedToConfig = true;
				} catch (setError: any) {
					// Check if it's a circular reference error - this is a known Bases issue
					// Silently fall back to localStorage without logging (to reduce console noise)
					const isCircularRef = setError?.message?.includes('circular') || setError?.message?.includes('Maximum call stack');
					if (!isCircularRef) {
						// Only log non-circular-reference errors
						console.warn('[EisenhowerMatrixView] Failed to save collapsed state to Bases config, falling back to localStorage:', setError);
					}
				}
			}
			
			// Fallback to localStorage if config.set() failed or isn't available
			if (!savedToConfig && this.app) {
				try {
					const storageKey = `tasknotes-eisenhower-collapsed-sections-${this.containerEl?.getAttribute('data-view-id') || 'default'}`;
					this.app.saveLocalStorage(storageKey, collapsedJson);
				} catch (localStorageError) {
					console.error('[EisenhowerMatrixView] Failed to save collapsed state to localStorage:', localStorageError);
				}
			}
		} catch (error) {
			console.error('[EisenhowerMatrixView] Failed to save collapsed state:', error);
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
		// For the four main quadrants, always use fixed height (400px total: 350px content + 50px header)
		// For holding-pen and excluded, use their own fixed height
		const heightForQuadrant = (quadrantId === "holding-pen" || quadrantId === "excluded") 
			? this.UNCATEGORIZED_FIXED_HEIGHT 
			: this.QUADRANT_FIXED_HEIGHT;
		const initialHeight = `${heightForQuadrant}px`;
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
			const tempHeight = heightForQuadrant; // Use the actual height for this quadrant
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
			
			// Load initial collapsed state from config
			const isInitiallyCollapsed = this.collapsedSections.has(quadrantId);
			
			// Set initial chevron position (will apply collapsed state after header is appended)
			if (isInitiallyCollapsed) {
				toggle.style.transform = "rotate(0deg)"; // Point right (collapsed)
			} else {
				toggle.style.transform = "rotate(90deg)"; // Point down (open)
			}
			
			let isCollapsed = isInitiallyCollapsed;
			
			this.addTrackedEventListener(toggle, "click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				isCollapsed = !isCollapsed;
				quadrant.classList.toggle("eisenhower-matrix__quadrant--collapsed", isCollapsed);
				// When collapsed, point right (0deg); when open, point down (90deg)
				toggle.style.transform = isCollapsed ? "rotate(0deg)" : "rotate(90deg)";
				
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
					// Save to config
					this.collapsedSections.add(quadrantId);
				} else {
					// Restore to original height (stored or default)
					const storedHeight = (quadrant as any).__originalHeight;
					const restoreHeight = storedHeight || heightForQuadrant;
					quadrant.style.height = `${restoreHeight}px`;
					// Remove from config
					this.collapsedSections.delete(quadrantId);
				}
				
				// Save collapsed state (on unload, like quadrant orderings, to avoid refresh)
				// We'll save on unload instead of here to prevent any refresh triggers
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
		
		// For holding-pen and excluded, use their fixed height. For the four main quadrants, always use fixed height with scrolling
		let tasksContainerHeight: string;
		let overflowSetting: string;
		
		if (quadrantId === "holding-pen" || quadrantId === "excluded") {
			// Holding pen and excluded always use fixed height with scrolling
			tasksContainerHeight = `${this.UNCATEGORIZED_FIXED_HEIGHT - headerHeight}px`;
			overflowSetting = "auto";
		} else {
			// Four main quadrants: always use fixed height (350px content) with scrolling
			tasksContainerHeight = "350px"; // 350px content area
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
					
					// Setup context menu with Eisenhower zone options
					this.setupTaskContextMenu(cardWrapper, task);
					
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
			this.addTrackedEventListener(tasksContainer, "dragover", (e: DragEvent) => {
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
			
			this.addTrackedEventListener(tasksContainer, "drop", async (e: DragEvent) => {
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
					// Pass fromQuadrant as parameter since we've already cleared this.draggedFromQuadrant
					await this.handleTaskDrop(taskPath, quadrantId, fromQuadrant);
					return; // Explicitly return to prevent further processing
				}
				// For same-quadrant drops or no valid drag, don't prevent - let it bubble
			});
		}

		quadrant.appendChild(tasksContainer);
		
		// Apply initial collapsed state after everything is appended (for collapsible sections)
		// Use requestAnimationFrame to ensure layout is complete before calculating height
		if (isCollapsible && this.collapsedSections.has(quadrantId)) {
			quadrant.classList.add("eisenhower-matrix__quadrant--collapsed");
			// Use requestAnimationFrame to ensure header is fully laid out
			requestAnimationFrame(() => {
				const headerHeight = header.offsetHeight || 50; // Fallback to 50px if calculation fails
				quadrant.style.height = `${headerHeight}px`;
			});
		}
		
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

	/**
	 * Check if this view is actually visible to the user.
	 * Returns false if the view is in a background tab, scrolled out of view, or not connected.
	 * Simplified to avoid expensive DOM operations that can cause crashes.
	 */
	private isViewVisible(): boolean {
		// Fast check: just verify element is connected
		// Avoid expensive getBoundingClientRect and getComputedStyle calls that can block
		if (!this.rootElement?.isConnected) {
			return false;
		}
		
		// Simple check: if container is not connected, view is not visible
		if (!this.containerEl?.isConnected) {
			return false;
		}
		
		// For embedded views, just check if the container is in the DOM
		// More expensive checks are deferred to avoid blocking
		return true;
	}

	/**
	 * Override onDataUpdated to skip refresh if we just did a selective update
	 */
	onDataUpdated(): void {
		// CRITICAL: Track rapid successive calls and block if too many
		this._onDataUpdatedCallCount++;
		if (this._onDataUpdatedCallResetTimer) {
			clearTimeout(this._onDataUpdatedCallResetTimer);
		}
		this._onDataUpdatedCallResetTimer = this.trackedSetTimeout(() => {
			this._onDataUpdatedCallCount = 0;
			this._onDataUpdatedCallResetTimer = null;
		}, 1000); // Reset count every second
		
		// If called too many times in a second, completely block
		if (this._onDataUpdatedCallCount > EisenhowerMatrixView.MAX_ON_DATA_UPDATED_CALLS_PER_SECOND) {
			// Too many calls - clear timer and exit
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
			}
			return;
		}
		
		// Early exit: Skip ALL processing if view is unloading (prevents work during file switches)
		if (this.isUnloading) {
			// Clear any pending timers
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
			}
			return;
		}
		
		// Early exit: Skip ALL processing if view is not visible
		// This prevents unnecessary work for views in background tabs
		if (!this.isViewVisible()) {
			// Clear any pending debounce timer since we're not visible
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
			}
			return;
		}
		
		// AGGRESSIVE: Block ALL updates during cooldown period
		// This prevents the matrix from disappearing due to rapid onDataUpdated calls
		if (this._renderBlocked || (this._initialRenderComplete && this._initialRenderCooldown > Date.now())) {
			// Still in cooldown/blocked period, skip this update entirely
			// Clear any pending debounce timer since we're blocking
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
			}
			return;
		}
		
		// Use instance-only flags to avoid cross-instance interference
		// Each view manages its own selective update state
		
		// Only calculate time-based check if we have a valid timestamp
		let justDidSelectiveUpdate = this.justDidSelectiveUpdate;
		if (this.lastSelectiveUpdateTime > 0) {
			const now = Date.now();
			const timeSinceSelectiveUpdate = now - this.lastSelectiveUpdateTime;
			const isWithinWindow = timeSinceSelectiveUpdate < EisenhowerMatrixView.SELECTIVE_UPDATE_WINDOW_MS;
			justDidSelectiveUpdate = justDidSelectiveUpdate || isWithinWindow;
		}
		
		const skipDataUpdateCount = this.skipDataUpdateCount;

		// If we just did a selective update, skip ALL refreshes
		// The UI is already up to date, so we don't need to refresh
		if (justDidSelectiveUpdate || this.skipNextDataUpdate || skipDataUpdateCount > 0) {
			
			// IMPORTANT: Ensure the view is still visible - Bases might have cleared it
			// Check both rootElement and matrixContainer
			const viewCleared = !this.rootElement?.isConnected || 
			                    !this.matrixContainer || 
			                    !this.matrixContainer.isConnected ||
			                    !this.rootElement.contains(this.matrixContainer);
			
			if (viewCleared) {
				// View was cleared, we need to render
				// But don't clear flags yet - we still need to skip the second onDataUpdated()
				// Just render directly without going through onDataUpdated()
				this.render();
				return;
			}
			
			// Update instance flags
			if (skipDataUpdateCount > 0) {
				this.skipDataUpdateCount = Math.max(0, this.skipDataUpdateCount - 1);
			}
			
			// Clear skipNextDataUpdate immediately (one-time skip)
			if (this.skipNextDataUpdate) {
				this.skipNextDataUpdate = false;
			}
			
			// Clear the flags after a delay to catch both file save and config.set() triggers
			if (justDidSelectiveUpdate) {
				this.trackedSetTimeout(() => {
					this.justDidSelectiveUpdate = false;
					// Don't clear static timestamp here - let it expire naturally
				}, 2000);
			}
			
			// IMPORTANT: Also clear any pending debounce timer from base class
			// This prevents a delayed render from firing after we've skipped
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
			}
			
			return;
		}

		// Otherwise, use longer debounce for external changes (typing in notes)
		// First data update after load should be immediate (initial data population)
		if (this._isFirstDataUpdate) {
			this._isFirstDataUpdate = false;
			try {
				this.render();
			} catch (error) {
				console.error(`[TaskNotes][${this.type}] Render error:`, error);
				this.renderError(error as Error);
			}
			return;
		}

		// Clear any existing debounce timer
		if ((this as any).dataUpdateDebounceTimer) {
			clearTimeout((this as any).dataUpdateDebounceTimer);
			(this as any).dataUpdateDebounceTimer = null;
		}

		// Use very long debounce for external changes (typing in notes)
		// This prevents excessive re-renders when editing notes with embedded matrix
		// Increased to 15 seconds for embedded views to drastically reduce CPU usage
		(this as any).dataUpdateDebounceTimer = this.trackedSetTimeout(() => {
			(this as any).dataUpdateDebounceTimer = null;
			// Multiple checks before rendering
			if (this.isUnloading || this._renderBlocked) {
				return;
			}
			// Double-check visibility before rendering
			if (!this.isViewVisible()) {
				return;
			}
			// Check cooldown again (might have been extended)
			if (this._initialRenderComplete && this._initialRenderCooldown > Date.now()) {
				return;
			}
			try {
				this.render();
			} catch (error) {
				console.error(`[TaskNotes][${this.type}] Render error:`, error);
				this.renderError(error as Error);
			}
		}, 15000);  // 15 second debounce - very long for embedded views to drastically reduce CPU usage
	}

	protected async handleTaskUpdate(task: TaskInfo): Promise<void> {
		// AGGRESSIVE: Skip ALL task updates during cooldown/blocking period
		// This prevents expensive processing when multiple views are open
		if (this._renderBlocked || (this._initialRenderComplete && this._initialRenderCooldown > Date.now())) {
			return;
		}
		
		// Skip if view is unloading
		if (this.isUnloading) {
			return;
		}
		
		// Skip if view is not visible (no point updating hidden views)
		if (!this.isViewVisible()) {
			return;
		}
		
		// Update cache
		this.taskInfoCache.set(task.path, task);
		
		// If we just did a selective update, skip this task update too
		// The UI is already up to date from the selective update
		if (this.justDidSelectiveUpdate || this.skipDataUpdateCount > 0) {
			return;
		}
		
		// Don't refresh here - onDataUpdated() will handle it if needed
		// But we've already blocked it above during cooldown
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
					
					// Setup context menu with Eisenhower zone options
					this.setupTaskContextMenu(cardWrapper, task);
					
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
		this.addTrackedEventListener(dropZone, "dragover", (e: DragEvent) => {
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

		this.addTrackedEventListener(dropZone, "dragleave", () => {
			dropZone.classList.remove("eisenhower-matrix__drop-zone--active");
		});

		this.addTrackedEventListener(dropZone, "drop", async (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation(); // Prevent any other handlers
				dropZone.classList.remove("eisenhower-matrix__drop-zone--active");
				
				// Prevent default drag behavior - we'll handle the DOM manipulation ourselves
				// Don't hide the element - handleTaskReorderToIndex will rebuild the DOM cleanly
				await this.handleTaskReorderToIndex(this.draggedTaskPath, quadrantId, insertIndex);
			}
			// For cross-quadrant drops, don't prevent - let it bubble to quadrant handler
		});

		container.appendChild(dropZone);
	}

	private setupCardDragHandlers(cardWrapper: HTMLElement, task: TaskInfo, quadrantId: Quadrant): void {
		// Check if handlers are already attached to avoid duplicates
		if ((cardWrapper as any).__dragHandlersAttached) {
			return;
		}
		(cardWrapper as any).__dragHandlersAttached = true;
		
		this.addTrackedEventListener(cardWrapper, "dragstart", (e: DragEvent) => {
			this.draggedTaskPath = task.path;
			this.draggedFromQuadrant = quadrantId;
			cardWrapper.classList.add("eisenhower-matrix__card--dragging");

			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", task.path);
				e.dataTransfer.setData("text/x-quadrant-id", quadrantId);
			}
		});

		this.addTrackedEventListener(cardWrapper, "dragend", () => {
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
		this.addTrackedEventListener(cardWrapper, "dragover", (e: DragEvent) => {
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

		this.addTrackedEventListener(cardWrapper, "dragleave", () => {
			cardWrapper.classList.remove("eisenhower-matrix__card-wrapper--dragover");
			cardWrapper.removeAttribute("data-insert-before");
		});

		this.addTrackedEventListener(cardWrapper, "drop", async (e: DragEvent) => {
			if (!this.draggedTaskPath || !this.draggedFromQuadrant) return;
			
			// Only handle if dragging within the same quadrant
			if (this.draggedFromQuadrant === quadrantId && this.draggedTaskPath !== task.path) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation(); // Prevent any other handlers
				cardWrapper.classList.remove("eisenhower-matrix__card-wrapper--dragover");
				
				const insertBefore = cardWrapper.getAttribute("data-insert-before") === "true";
				cardWrapper.removeAttribute("data-insert-before");
				
				// Prevent default drag behavior - we'll handle the DOM manipulation ourselves
				const quadrant = cardWrapper.closest('.eisenhower-matrix__quadrant') as HTMLElement;
				const tasksContainer = quadrant?.querySelector('.eisenhower-matrix__quadrant-tasks') as HTMLElement;
				const draggedElement = tasksContainer?.querySelector(`[data-task-path="${CSS.escape(this.draggedTaskPath)}"]`) as HTMLElement;
				if (draggedElement && draggedElement !== cardWrapper) {
					// Temporarily hide the dragged element to prevent visual glitches
					const originalDisplay = draggedElement.style.display;
					draggedElement.style.display = 'none';
					
					await this.handleTaskReorder(this.draggedTaskPath, task.path, quadrantId, insertBefore);
					
					// Restore display (handleTaskReorder will have moved it)
					draggedElement.style.display = originalDisplay;
				} else {
					await this.handleTaskReorder(this.draggedTaskPath, task.path, quadrantId, insertBefore);
				}
				return; // Explicitly return to prevent further processing
			}
			// For cross-quadrant drops, don't prevent default or stop propagation
			// Let the event bubble up to the quadrant's drop handler
		});
	}

	private setupQuadrantDropHandlers(quadrant: HTMLElement, quadrantId: Quadrant): void {
		// Drag over handler - must always prevent default for drops to work
		this.addTrackedEventListener(quadrant, "dragover", (e: DragEvent) => {
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
		this.addTrackedEventListener(quadrant, "dragleave", (e: DragEvent) => {
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
		this.addTrackedEventListener(quadrant, "drop", async (e: DragEvent) => {
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
			
			// Pass fromQuadrant as parameter since we've already cleared this.draggedFromQuadrant
			await this.handleTaskDrop(taskPath, quadrantId, fromQuadrant);
		}, true); // Use capture phase
	}

	private async handleTaskReorderToIndex(draggedTaskPath: string, quadrantId: Quadrant, targetIndex: number): Promise<void> {
		try {
			// No flags needed - we're not calling config.set() anymore
			// DOM is already updated via drag and drop, no refresh needed
			
			// Get current ordering for this quadrant
			let ordering = this.quadrantOrderings.get(quadrantId);
			if (!ordering) {
				ordering = new Map();
				this.quadrantOrderings.set(quadrantId, ordering);
			}

			// Get all tasks in this quadrant to determine current positions
			const tasksContainer = this.matrixContainer?.querySelector(
				`.eisenhower-matrix__quadrant--${quadrantId} .eisenhower-matrix__quadrant-tasks`
			) as HTMLElement;
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

			// Reorder DOM elements to match the new ordering
			// First, get fresh list of wrappers (drag-and-drop may have already moved one)
			const currentWrappers = Array.from(tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper')) as HTMLElement[];
			
			console.log(`[EisenhowerMatrixView] Reordering quadrant ${quadrantId}: ${currentWrappers.length} wrappers, ${taskPaths.length} paths`);
			
			// Verify we have the right number of wrappers
			if (currentWrappers.length !== taskPaths.length) {
				console.warn(`[EisenhowerMatrixView] Mismatch: ${currentWrappers.length} wrappers vs ${taskPaths.length} paths`);
			}
			
			// Sort wrappers by their order in the ordering map
			const sortedWrappers = currentWrappers.sort((a, b) => {
				const pathA = a.getAttribute('data-task-path');
				const pathB = b.getAttribute('data-task-path');
				const orderA = pathA ? ordering!.get(pathA) ?? Infinity : Infinity;
				const orderB = pathB ? ordering!.get(pathB) ?? Infinity : Infinity;
				return orderA - orderB;
			});

			// Remove all drop zones and empty states first (we'll recreate them)
			const existingDropZones = tasksContainer.querySelectorAll('.eisenhower-matrix__drop-zone');
			existingDropZones.forEach(zone => (zone as HTMLElement).remove());
			const existingEmpty = tasksContainer.querySelector('.eisenhower-matrix__quadrant-empty');
			if (existingEmpty) {
				existingEmpty.remove();
			}

			// Clear container and re-append wrappers in sorted order
			// This ensures clean ordering without duplicates
			while (tasksContainer.firstChild) {
				tasksContainer.removeChild(tasksContainer.firstChild);
			}
			
			// Add drop zone at the beginning
			this.createDropZone(tasksContainer, quadrantId, null, 0);
			
			// Re-append wrappers in sorted order and re-attach drag handlers
			sortedWrappers.forEach((wrapper, index) => {
				tasksContainer.appendChild(wrapper);
				// Re-attach drag handlers since we rebuilt the DOM
				const taskPath = wrapper.getAttribute('data-task-path');
				if (taskPath) {
					const task = this.taskInfoCache.get(taskPath);
					if (task) {
						this.setupCardDragHandlers(wrapper, task, quadrantId);
					}
				}
				// Add drop zone after each wrapper
				this.createDropZone(tasksContainer, quadrantId, taskPath, index + 1);
			});

			// Don't save ordering here - will be saved on unload
			// This prevents config.set() from triggering refreshes
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error reordering task:", error);
		}
	}

	private async handleTaskReorder(draggedTaskPath: string, targetTaskPath: string, quadrantId: Quadrant, insertBefore: boolean): Promise<void> {
		try {
			// No flags needed - we're not calling config.set() anymore
			// DOM is already updated via drag and drop, no refresh needed
			
			// Get current ordering for this quadrant
			let ordering = this.quadrantOrderings.get(quadrantId);
			if (!ordering) {
				ordering = new Map();
				this.quadrantOrderings.set(quadrantId, ordering);
			}

			// Get all tasks in this quadrant to determine current positions
			const tasksContainer = this.matrixContainer?.querySelector(
				`.eisenhower-matrix__quadrant--${quadrantId} .eisenhower-matrix__quadrant-tasks`
			) as HTMLElement;
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

			// Reorder DOM elements to match the new ordering
			// First, get fresh list of wrappers (drag-and-drop may have already moved one)
			const currentWrappers = Array.from(tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper')) as HTMLElement[];
			
			// Verify we have the right number of wrappers
			if (currentWrappers.length !== taskPaths.length) {
				console.warn(`[EisenhowerMatrixView] Mismatch: ${currentWrappers.length} wrappers vs ${taskPaths.length} paths`);
			}
			
			// Sort wrappers by their order in the ordering map
			const sortedWrappers = currentWrappers.sort((a, b) => {
				const pathA = a.getAttribute('data-task-path');
				const pathB = b.getAttribute('data-task-path');
				const orderA = pathA ? ordering!.get(pathA) ?? Infinity : Infinity;
				const orderB = pathB ? ordering!.get(pathB) ?? Infinity : Infinity;
				return orderA - orderB;
			});

			// Remove all drop zones and empty states first (we'll recreate them)
			const existingDropZones = tasksContainer.querySelectorAll('.eisenhower-matrix__drop-zone');
			existingDropZones.forEach(zone => (zone as HTMLElement).remove());
			const existingEmpty = tasksContainer.querySelector('.eisenhower-matrix__quadrant-empty');
			if (existingEmpty) {
				existingEmpty.remove();
			}

			// Clear container and re-append wrappers in sorted order
			// This ensures clean ordering without duplicates
			while (tasksContainer.firstChild) {
				tasksContainer.removeChild(tasksContainer.firstChild);
			}
			
			// Add drop zone at the beginning
			this.createDropZone(tasksContainer, quadrantId, null, 0);
			
			// Re-append wrappers in sorted order and re-attach drag handlers
			sortedWrappers.forEach((wrapper, index) => {
				tasksContainer.appendChild(wrapper);
				// Re-attach drag handlers since we rebuilt the DOM
				const taskPath = wrapper.getAttribute('data-task-path');
				if (taskPath) {
			const task = this.taskInfoCache.get(taskPath);
					if (task) {
						this.setupCardDragHandlers(wrapper, task, quadrantId);
					}
				}
				// Add drop zone after each wrapper
				this.createDropZone(tasksContainer, quadrantId, taskPath, index + 1);
			});

			// Don't save ordering here - will be saved on unload
			// This prevents config.set() from triggering refreshes
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error reordering task:", error);
		}
	}

	private async handleTaskDrop(taskPath: string, targetQuadrant: Quadrant, fromQuadrant?: Quadrant | null): Promise<void> {
		// Use provided fromQuadrant, or fall back to this.draggedFromQuadrant if not provided
		const sourceQuadrant = fromQuadrant !== undefined ? fromQuadrant : this.draggedFromQuadrant;
		
		// Check if this is a same-quadrant drop (should be handled by handleTaskReorder instead)
		if (sourceQuadrant === targetQuadrant) {
			// Same quadrant drops are handled by card drop handlers
			return;
		}

		try {
			console.log(`[EisenhowerMatrixView] handleTaskDrop: taskPath=${taskPath}, fromQuadrant=${sourceQuadrant}, targetQuadrant=${targetQuadrant}`);
			
			// Set flags BEFORE updating task to prevent onDataUpdated() from triggering a full refresh
			// We'll update the UI selectively instead
			// We expect 2 onDataUpdated() calls: one from file save, one from config.set()
			// Skip BOTH to avoid any refresh - the selective update handles the UI
			// Use both instance and static flags (in case view is recreated)
			this.justDidSelectiveUpdate = true;
			this.skipDataUpdateCount = 2; // Skip both onDataUpdated() calls
			
			// Set instance flags for this view only (prevents cross-instance interference)
			this.lastSelectiveUpdateTime = Date.now();
			this.skipDataUpdateCount = 2; // Skip both
			
			// Clear any pending debounce timer to prevent a quick refresh
			if ((this as any).dataUpdateDebounceTimer) {
				clearTimeout((this as any).dataUpdateDebounceTimer);
				(this as any).dataUpdateDebounceTimer = null;
				console.log("[EisenhowerMatrixView] Cleared pending dataUpdateDebounceTimer before selective update");
			}
			
			const task = this.taskInfoCache.get(taskPath);
			let updatedTask: TaskInfo;
			
			// IMPORTANT: Remove from old quadrant BEFORE updating task tags
			// Use the sourceQuadrant (it may have been cleared by now)
			if (sourceQuadrant && sourceQuadrant !== targetQuadrant) {
				console.log(`[EisenhowerMatrixView] Attempting to remove task ${taskPath} from quadrant ${sourceQuadrant}`);
				await this.updateQuadrantSelectivelyByPath(sourceQuadrant, taskPath, 'remove');
			} else {
				console.log(`[EisenhowerMatrixView] No sourceQuadrant or same quadrant, skipping removal. sourceQuadrant=${sourceQuadrant}, targetQuadrant=${targetQuadrant}`);
			}
			
			if (!task) {
				// Try to load the task if not in cache
				const file = this.app.vault.getAbstractFileByPath(taskPath);
				if (!(file instanceof TFile)) return;
				
				const loadedTask = await this.plugin.cacheManager.getTaskInfo(taskPath);
				if (!loadedTask) return;
				
				await this.updateTaskTagsForQuadrant(loadedTask, targetQuadrant);
				updatedTask = loadedTask;
			} else {
				await this.updateTaskTagsForQuadrant(task, targetQuadrant);
				updatedTask = task;
			}

			// Update UI selectively - add to new quadrant
			await this.updateQuadrantSelectively(targetQuadrant, updatedTask, 'add');

			// Clear ordering for the old quadrant and assign new order in target quadrant
			// Use the sourceQuadrant
			if (sourceQuadrant && sourceQuadrant !== targetQuadrant) {
				const oldOrdering = this.quadrantOrderings.get(sourceQuadrant);
				if (oldOrdering) {
					oldOrdering.delete(taskPath);
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
			
			// Don't save ordering here - will be saved on unload
			// This prevents config.set() from triggering refreshes
			
			// Ensure view is still visible after selective update
			// Check after a short delay to catch any clearing that happens asynchronously
			// Also check after config.set() completes (which triggers the second onDataUpdated)
			this.trackedSetTimeout(() => {
				if (!this.matrixContainer || !this.matrixContainer.isConnected || 
				    !this.rootElement?.contains(this.matrixContainer)) {
					console.log("[EisenhowerMatrixView] View was cleared after selective update, forcing render");
					// Don't clear flags here - they need to stay active for the second onDataUpdated()
					// Just force a render to restore the view
					this.render();
				}
			}, 500); // Longer delay to catch config.set() trigger
		} catch (error) {
			console.error("[TaskNotes][EisenhowerMatrixView] Error updating task:", error);
			// Clear flags on error so view can refresh normally
			this.justDidSelectiveUpdate = false;
			this.skipDataUpdateCount = 0;
			this.lastSelectiveUpdateTime = 0;
			this.skipDataUpdateCount = 0;
		}
	}

	/**
	 * Selectively update a quadrant by removing a task by path (more reliable)
	 */
	private async updateQuadrantSelectivelyByPath(quadrantId: Quadrant, taskPath: string, action: 'remove'): Promise<void> {
		if (!this.matrixContainer) return;

		const quadrant = this.matrixContainer.querySelector(`.eisenhower-matrix__quadrant--${quadrantId}`);
		if (!quadrant) return;

		const tasksContainer = quadrant.querySelector('.eisenhower-matrix__quadrant-tasks') as HTMLElement;
		if (!tasksContainer) return;

		const header = quadrant.querySelector('.eisenhower-matrix__quadrant-header');
		const countSpan = header?.querySelector('.eisenhower-matrix__quadrant-count');

		if (action === 'remove') {
			// Remove the task card by path
			// First, get all wrappers to see what we have
			const allWrappers = tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper');
			
			// Collect all paths for debugging (only used if removal fails)
			const allPaths: string[] = [];
			allWrappers.forEach((wrapper) => {
				const path = (wrapper as HTMLElement).getAttribute('data-task-path');
				if (path) allPaths.push(path);
			});
			
			let cardWrapper = tasksContainer.querySelector(`[data-task-path="${CSS.escape(taskPath)}"]`) as HTMLElement;
			
			// If not found with CSS.escape, try without escaping
			if (!cardWrapper) {
				cardWrapper = tasksContainer.querySelector(`[data-task-path="${taskPath}"]`) as HTMLElement;
			}
			
			// If still not found, try finding by iterating through all wrappers
			if (!cardWrapper) {
				for (const wrapper of allWrappers) {
					const path = (wrapper as HTMLElement).getAttribute('data-task-path');
					if (path === taskPath) {
						cardWrapper = wrapper as HTMLElement;
						break;
					}
				}
			}
			
			if (cardWrapper) {
				// Also remove the drop zone after it if it exists
				const nextSibling = cardWrapper.nextElementSibling;
				if (nextSibling && nextSibling.classList.contains('eisenhower-matrix__drop-zone')) {
					nextSibling.remove();
				}
				// Also check for drop zone before it
				const prevSibling = cardWrapper.previousElementSibling;
				if (prevSibling && prevSibling.classList.contains('eisenhower-matrix__drop-zone')) {
					prevSibling.remove();
				}
				cardWrapper.remove();
			} else {
				console.warn(`[EisenhowerMatrixView] ✗ Could not find task card to remove: ${taskPath} from quadrant ${quadrantId}`);
				console.warn(`[EisenhowerMatrixView] Available paths:`, allPaths);
			}

			// Update count
			if (countSpan) {
				const currentCount = tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper').length;
				countSpan.textContent = `(${currentCount})`;
			}

			// If quadrant is now empty, show empty state
			if (tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper').length === 0) {
				const existingEmpty = tasksContainer.querySelector('.eisenhower-matrix__quadrant-empty');
				if (!existingEmpty) {
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
				}
			}
		}
	}

	/**
	 * Selectively update a quadrant by adding or removing a task without full refresh
	 */
	private async updateQuadrantSelectively(quadrantId: Quadrant, task: TaskInfo, action: 'add' | 'remove'): Promise<void> {
		if (!this.matrixContainer) return;

		const quadrant = this.matrixContainer.querySelector(`.eisenhower-matrix__quadrant--${quadrantId}`);
		if (!quadrant) return;

		const tasksContainer = quadrant.querySelector('.eisenhower-matrix__quadrant-tasks') as HTMLElement;
		if (!tasksContainer) return;

		const header = quadrant.querySelector('.eisenhower-matrix__quadrant-header');
		const countSpan = header?.querySelector('.eisenhower-matrix__quadrant-count');

		if (action === 'remove') {
			// Remove the task card
			// Try multiple approaches to find the card
			let cardWrapper = tasksContainer.querySelector(`[data-task-path="${CSS.escape(task.path)}"]`) as HTMLElement;
			
			// If not found with CSS.escape, try without escaping
			if (!cardWrapper) {
				cardWrapper = tasksContainer.querySelector(`[data-task-path="${task.path}"]`) as HTMLElement;
			}
			
			// If still not found, try finding by iterating through all wrappers
			if (!cardWrapper) {
				const allWrappers = tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper');
				for (const wrapper of allWrappers) {
					const path = (wrapper as HTMLElement).getAttribute('data-task-path');
					if (path === task.path) {
						cardWrapper = wrapper as HTMLElement;
						break;
					}
				}
			}
			
			if (cardWrapper) {
				// Also remove the drop zone after it if it exists
				const nextSibling = cardWrapper.nextElementSibling;
				if (nextSibling && nextSibling.classList.contains('eisenhower-matrix__drop-zone')) {
					nextSibling.remove();
				}
				// Also check for drop zone before it
				const prevSibling = cardWrapper.previousElementSibling;
				if (prevSibling && prevSibling.classList.contains('eisenhower-matrix__drop-zone')) {
					prevSibling.remove();
				}
				cardWrapper.remove();
			} else {
				console.warn(`[EisenhowerMatrixView] Could not find task card to remove: ${task.path}`);
			}

			// Update count
			if (countSpan) {
				const currentCount = tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper').length;
				countSpan.textContent = `(${currentCount})`;
			}

			// If quadrant is now empty, show empty state
			if (tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper').length === 0) {
				const existingEmpty = tasksContainer.querySelector('.eisenhower-matrix__quadrant-empty');
				if (!existingEmpty) {
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
				}
			}
		} else if (action === 'add') {
			// Remove empty state if present
			const empty = tasksContainer.querySelector('.eisenhower-matrix__quadrant-empty');
			if (empty) {
				empty.remove();
			}

			// Get ordering to determine position
			const ordering = this.quadrantOrderings.get(quadrantId);
			const taskOrder = ordering?.get(task.path) ?? -1;

			// Find the right position to insert
			const cardWrappers = Array.from(tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper'));
			let insertIndex = cardWrappers.length; // Default to end

			if (taskOrder >= 0 && ordering) {
				// Find position based on ordering
				for (let i = 0; i < cardWrappers.length; i++) {
					const wrapper = cardWrappers[i] as HTMLElement;
					const path = wrapper.getAttribute('data-task-path');
					const order = path ? ordering.get(path) ?? -1 : -1;
					if (order > taskOrder) {
						insertIndex = i;
						break;
					}
				}
			}

			// Create the card
			const visibleProperties = this.getVisibleProperties();
			const cardOptions = this.getCardOptions();
			const cardWrapper = document.createElement("div");
			cardWrapper.className = "eisenhower-matrix__card-wrapper";
			cardWrapper.setAttribute("draggable", "true");
			cardWrapper.setAttribute("data-task-path", task.path);
			
			const card = createTaskCard(task, this.plugin, visibleProperties, cardOptions);
			cardWrapper.appendChild(card);
			this.taskInfoCache.set(task.path, task);
			
			// Setup drag handlers
			this.setupCardDragHandlers(cardWrapper, task, quadrantId);
			
			// Setup context menu with Eisenhower zone options
			this.setupTaskContextMenu(cardWrapper, task);

			// Insert at the right position
			if (insertIndex === 0) {
				// Insert at beginning (after first drop zone if it exists)
				const firstDropZone = tasksContainer.querySelector('.eisenhower-matrix__drop-zone');
				if (firstDropZone && firstDropZone.nextSibling) {
					tasksContainer.insertBefore(cardWrapper, firstDropZone.nextSibling);
				} else {
					tasksContainer.insertBefore(cardWrapper, tasksContainer.firstChild);
				}
				// Add drop zone after this card
				this.createDropZone(tasksContainer, quadrantId, task.path, 1);
			} else if (insertIndex >= cardWrappers.length) {
				// Insert at end
				tasksContainer.appendChild(cardWrapper);
				// Add drop zone after this card
				this.createDropZone(tasksContainer, quadrantId, task.path, cardWrappers.length + 1);
			} else {
				// Insert in middle
				const targetWrapper = cardWrappers[insertIndex] as HTMLElement;
				tasksContainer.insertBefore(cardWrapper, targetWrapper);
				// Add drop zone after this card
				this.createDropZone(tasksContainer, quadrantId, task.path, insertIndex + 1);
			}

			// Update count
			if (countSpan) {
				const currentCount = tasksContainer.querySelectorAll('.eisenhower-matrix__card-wrapper').length;
				countSpan.textContent = `(${currentCount})`;
			}
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

	/**
	 * Setup context menu for a task card with Eisenhower zone options
	 */
	private setupTaskContextMenu(cardWrapper: HTMLElement, task: TaskInfo): void {
		// Find the actual task card element (it might be nested inside the wrapper)
		const card = (cardWrapper.querySelector(".task-card") || cardWrapper) as HTMLElement;
		
		this.addTrackedEventListener(card, "contextmenu", async (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			
			// Get fresh task data
			const freshTask = await this.plugin.cacheManager.getTaskInfo(task.path);
			if (!freshTask) {
				console.error("[EisenhowerMatrixView] Task not found:", task.path);
				return;
			}
			
			// Create standard task context menu
			const { TaskContextMenu } = await import("../components/TaskContextMenu");
			const taskMenu = new TaskContextMenu({
				task: freshTask,
				plugin: this.plugin,
				targetDate: this.getCardOptions().targetDate,
				onUpdate: () => {
					// Trigger refresh of views
					this.plugin.app.workspace.trigger("tasknotes:refresh-views");
				},
			});
			
			// Access the underlying menu to add our items
			const menu = (taskMenu as any).menu as any;
			
			// Add "Move to Eisenhower zone" submenu at the top
			menu.addItem((item: any) => {
				item.setTitle("Move to Eisenhower zone");
				item.setIcon("move");
				
				const submenu = (item as any).setSubmenu();
				
				// Define quadrant options
				const quadrantOptions: Array<{ quadrant: Quadrant; label: string; icon?: string }> = [
					{ quadrant: "urgent-important", label: "Do", icon: "zap" },
					{ quadrant: "not-urgent-important", label: "Decide", icon: "calendar" },
					{ quadrant: "urgent-not-important", label: "Delegate", icon: "user" },
					{ quadrant: "not-urgent-not-important", label: "Defer", icon: "clock" },
					{ quadrant: "holding-pen", label: "Uncategorized", icon: "list" },
					{ quadrant: "excluded", label: "Excluded", icon: "x" },
				];
				
				// Add menu items for each quadrant
				for (const option of quadrantOptions) {
					submenu.addItem((subItem: any) => {
						subItem.setTitle(option.label);
						if (option.icon) {
							subItem.setIcon(option.icon);
						}
						subItem.onClick(async () => {
							try {
								// Set flags BEFORE updating task to prevent onDataUpdated() from triggering a full refresh
								// We expect 2 onDataUpdated() calls: one from file save, one from config.set()
								// Skip BOTH to avoid any refresh - the selective update handles the UI
								// Use both instance and static flags (in case view is recreated)
								this.justDidSelectiveUpdate = true;
								this.skipDataUpdateCount = 2; // Skip both onDataUpdated() calls
								
								// Set instance flags for this view only (prevents cross-instance interference)
								this.lastSelectiveUpdateTime = Date.now();
								this.skipDataUpdateCount = 2; // Skip both
								
								// Clear any pending debounce timer to prevent a quick refresh
								if ((this as any).dataUpdateDebounceTimer) {
									clearTimeout((this as any).dataUpdateDebounceTimer);
									(this as any).dataUpdateDebounceTimer = null;
									console.log("[EisenhowerMatrixView] Cleared pending dataUpdateDebounceTimer before selective update (context menu)");
								}
								
								// Get fresh task data again
								const updatedTask = await this.plugin.cacheManager.getTaskInfo(task.path);
								if (!updatedTask) {
									console.error("[EisenhowerMatrixView] Task not found:", task.path);
									return;
								}
								
								// Determine current quadrant from task tags (before update)
								const currentQuadrant = this.getQuadrantForTask(updatedTask);
								
								// IMPORTANT: Remove from old quadrant BEFORE updating task tags
								// Use the original task to find it in the old quadrant
								if (currentQuadrant && currentQuadrant !== option.quadrant) {
									await this.updateQuadrantSelectively(currentQuadrant, updatedTask, 'remove');
								}
								
								// Update task tags for the target quadrant
								await this.updateTaskTagsForQuadrant(updatedTask, option.quadrant);
								
								// Get fresh task data after update to ensure we have the latest tags
								const finalTask = await this.plugin.cacheManager.getTaskInfo(task.path);
								if (!finalTask) return;
								
								// Update ordering - remove from old quadrant, add to new
								if (currentQuadrant && currentQuadrant !== option.quadrant) {
									// Update UI selectively - remove from old quadrant
									await this.updateQuadrantSelectively(currentQuadrant, updatedTask, 'remove');
									
									const oldOrdering = this.quadrantOrderings.get(currentQuadrant);
									if (oldOrdering) {
										oldOrdering.delete(task.path);
									}
								}
								
								// Add to end of target quadrant's ordering
								let targetOrdering = this.quadrantOrderings.get(option.quadrant);
								if (!targetOrdering) {
									targetOrdering = new Map();
									this.quadrantOrderings.set(option.quadrant, targetOrdering);
								}
								const maxOrder = targetOrdering.size > 0 
									? Math.max(...Array.from(targetOrdering.values()))
									: -1;
								targetOrdering.set(task.path, maxOrder + 1);
								
								// Update UI selectively - add to new quadrant
								await this.updateQuadrantSelectively(option.quadrant, finalTask, 'add');
								
								// Don't save ordering here - will be saved on unload
								// This prevents config.set() from triggering refreshes
								
								// Ensure view is still visible after selective update
								// Check after a short delay to catch any clearing that happens asynchronously
								// Also check after config.set() completes (which triggers the second onDataUpdated)
								this.trackedSetTimeout(() => {
									if (!this.matrixContainer || !this.matrixContainer.isConnected || 
									    !this.rootElement?.contains(this.matrixContainer)) {
										console.log("[EisenhowerMatrixView] View was cleared after selective update (context menu), forcing render");
										// Don't clear flags here - they need to stay active for the second onDataUpdated()
										// Just force a render to restore the view
										this.render();
									}
								}, 500); // Longer delay to catch config.set() trigger
							} catch (error) {
								console.error("[TaskNotes][EisenhowerMatrixView] Error moving task:", error);
								// Clear flags on error so view can refresh normally
								this.justDidSelectiveUpdate = false;
								this.skipDataUpdateCount = 0;
								this.lastSelectiveUpdateTime = 0;
								this.skipDataUpdateCount = 0;
							}
						});
					});
				}
			});
			
			taskMenu.show(e);
		});
	}

	/**
	 * Get the quadrant for a task based on its tags
	 */
	private getQuadrantForTask(task: TaskInfo): Quadrant | null {
		const hasYImportant = this.hasTag(task, "yImportant");
		const hasNImportant = this.hasTag(task, "nImportant");
		const hasYUrgent = this.hasTag(task, "yUrgent");
		const hasNUrgent = this.hasTag(task, "nUrgent");
		const hasExcluded = this.hasTag(task, "excluded");

		if (hasExcluded) {
			return "excluded";
		}

		const hasAnyTag = hasYImportant || hasNImportant || hasYUrgent || hasNUrgent;
		if (!hasAnyTag) {
			return "holding-pen";
		}

		const isUrgent = hasYUrgent && !hasNUrgent;
		const isImportant = hasYImportant && !hasNImportant;

		if (isUrgent && isImportant) {
			return "urgent-important";
		} else if (isUrgent && !isImportant) {
			return "urgent-not-important";
		} else if (!isUrgent && isImportant) {
			return "not-urgent-important";
		} else {
			return "not-urgent-not-important";
		}
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
		// Prevent multiple save attempts if onunload() is called multiple times
		if (this.isUnloading) {
			return;
		}
		this.isUnloading = true;
		
		// AGGRESSIVE: Block all renders immediately
		this._renderBlocked = true;
		
		// Cancel all pending operations to prevent renders during/after unload
		if ((this as any).dataUpdateDebounceTimer) {
			clearTimeout((this as any).dataUpdateDebounceTimer);
			(this as any).dataUpdateDebounceTimer = null;
		}
		if (this._throttleTimer !== null) {
			clearTimeout(this._throttleTimer);
			this._throttleTimer = null;
		}
		if (this._onDataUpdatedCallResetTimer !== null) {
			clearTimeout(this._onDataUpdatedCallResetTimer);
			this._onDataUpdatedCallResetTimer = null;
		}
		
		// Clear render flags to prevent any pending renders
		this._isRendering = false;
		this._pendingRender = false;
		
		// Clean up all event listeners
		for (const { element, event, handler } of this.eventListeners) {
			try {
				element.removeEventListener(event, handler);
			} catch (error) {
				// Ignore errors during cleanup (element might already be removed)
			}
		}
		this.eventListeners = [];
		
		// Clean up all timers
		for (const timerId of this.activeTimers) {
			clearTimeout(timerId);
		}
		this.activeTimers.clear();
		
		// Clean up virtual scrollers
		this.destroyQuadrantScrollers();
		this.taskInfoCache.clear();
		
		// CRITICAL: Don't save config during unload - config.set() triggers onDataUpdated() on ALL instances
		// This causes cascading renders and slowdowns when switching between notes
		// Instead, save will happen on next render when view is loaded again
		// The orderings and collapsed state are already in memory and will be saved when needed
		
		this.matrixContainer = null;
		
		// Clear instance flags on unload
		this.lastSelectiveUpdateTime = 0;
		this.skipDataUpdateCount = 0;
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


