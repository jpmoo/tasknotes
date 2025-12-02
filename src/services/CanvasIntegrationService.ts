/* eslint-disable no-console */
// Canvas integration - debug messages removed for production
import { Component, TFile, WorkspaceLeaf } from "obsidian";
import TaskNotesPlugin from "../main";
import { TaskInfo, EVENT_TASK_UPDATED, EVENT_DATA_CHANGED } from "../types";
import { createTaskCard } from "../ui/TaskCard";
import { updateTaskCard } from "../ui/TaskCard";
import { convertInternalToUserProperties, isPropertyForField } from "../utils/propertyMapping";

/**
 * Service to integrate TaskNotes with Obsidian Canvas
 * Replaces TaskNote file nodes on Canvas with interactive task cards
 */
export class CanvasIntegrationService extends Component {
	private plugin: TaskNotesPlugin;
	private canvasViews = new Map<WorkspaceLeaf, CanvasViewState>();
	private debounceTimer: number | null = null;

	constructor(plugin: TaskNotesPlugin) {
		super();
		this.plugin = plugin;
	}

	onload(): void {
		// Initial scan of existing Canvas views
		this.scanCanvasViews();

		// Listen for workspace changes to detect new Canvas views
		this.registerEvent(
			this.plugin.app.workspace.on("layout-change", () => {
				this.debouncedScan();
			})
		);

		// Listen for active leaf changes
		this.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", () => {
				this.debouncedScan();
			})
		);

		// Listen for task updates to refresh Canvas cards
		this.registerEvent(
			this.plugin.emitter.on(EVENT_TASK_UPDATED, () => {
				this.debouncedRefresh();
			})
		);

		this.registerEvent(
			this.plugin.emitter.on(EVENT_DATA_CHANGED, () => {
				this.debouncedRefresh();
			})
		);

		// Listen for metadata changes (task file updates)
		this.registerEvent(
			this.plugin.app.metadataCache.on("changed", (file) => {
				if (this.isTaskFile(file)) {
					this.debouncedRefresh();
				}
			})
		);
	}

	onunload(): void {
		// Clean up all Canvas view states
		for (const state of this.canvasViews.values()) {
			this.cleanupCanvasView(state);
		}
		this.canvasViews.clear();

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private debouncedScan(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.scanCanvasViews();
		}, 100);
	}

	private debouncedRefresh(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.refreshAllCanvasViews();
		}, 100);
	}

	private scanCanvasViews(): void {
		const canvasLeaves = this.plugin.app.workspace.getLeavesOfType("canvas");

		// Track which leaves still exist
		const activeLeaves = new Set<WorkspaceLeaf>();

		// Process existing and new Canvas views
		for (const leaf of canvasLeaves) {
			activeLeaves.add(leaf);

			if (!this.canvasViews.has(leaf)) {
				// New Canvas view - set up observer
				this.setupCanvasView(leaf);
			}
		}

		// Clean up removed Canvas views
		for (const [leaf, state] of this.canvasViews.entries()) {
			if (!activeLeaves.has(leaf)) {
				this.cleanupCanvasView(state);
				this.canvasViews.delete(leaf);
			}
		}
	}

	private setupCanvasView(leaf: WorkspaceLeaf): void {
		const state: CanvasViewState = {
			leaf,
			observer: null,
			taskNodes: new Map(),
		};

		// Wait for Canvas view to be ready
		setTimeout(() => {
			this.processCanvasView(state);
		}, 200);

		this.canvasViews.set(leaf, state);
	}

	private processCanvasView(state: CanvasViewState): void {
		const view = state.leaf.view as any;
		if (!view || !view.canvas) return;

		const canvas = view.canvas;
		const canvasEl = canvas.wrapperEl;
		if (!canvasEl) return;

		// Set up MutationObserver to watch for new nodes
		state.observer = new MutationObserver((mutations) => {
			// Only process if nodes were actually added/changed
			const hasRelevantChanges = mutations.some(mutation => {
				return mutation.addedNodes.length > 0 || 
				       mutation.type === "attributes" ||
				       (mutation.target as HTMLElement).classList?.contains("canvas-node");
			});
			
			if (hasRelevantChanges) {
				// Debounce to avoid excessive processing
				setTimeout(() => {
					this.processCanvasNodes(state);
				}, 300);
			}
		});

		state.observer.observe(canvasEl, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-node-id", "data-id", "class"],
		});

		// Also set up a periodic check to catch nodes that might be missed
		const intervalId = setInterval(() => {
			if (!this.canvasViews.has(state.leaf)) {
				clearInterval(intervalId);
				return;
			}
			this.processCanvasNodes(state);
		}, 2000);

		// Store interval ID for cleanup
		(state as any).intervalId = intervalId;

		// Initial processing with multiple attempts (nodes might render asynchronously)
		// Use longer delays to ensure nodes are fully rendered
		this.processCanvasNodes(state);
		setTimeout(() => this.processCanvasNodes(state), 1000);
		setTimeout(() => this.processCanvasNodes(state), 2000);
		setTimeout(() => this.processCanvasNodes(state), 3000);
		setTimeout(() => this.processCanvasNodes(state), 5000);
	}

	private processCanvasNodes(state: CanvasViewState): void {
		const view = state.leaf.view as any;
		if (!view || !view.canvas) return;

		const canvas = view.canvas;
		const canvasEl = canvas.wrapperEl;
		if (!canvasEl) return;

		// Get Canvas data to find file nodes
		let canvasData;
		try {
			canvasData = canvas.getData();
		} catch (error) {
			return;
		}

		// Try to use Canvas API's nodeViews map first
		const nodeViews = (canvas as any).nodeViews;
		
		// Also try to hook into Canvas's rendering if possible
		// Check if we can intercept markdown rendering
		if (canvas && !(canvas as any).__tasknotesHooked) {
			(canvas as any).__tasknotesHooked = true;
			
			// Try to intercept markdown rendering by watching for new markdown embeds
			const originalRequestIdleCallback = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 0));
			const checkForNewNodes = () => {
				// Process nodes periodically
				setTimeout(() => {
					this.processCanvasNodes(state);
				}, 1000);
			};
			
			// Check periodically for new nodes
			setInterval(checkForNewNodes, 2000);
		}

		// Scan DOM directly for file nodes and match by file path
		const allNodes = canvasEl.querySelectorAll(".canvas-node");
		
		// Build a map of file paths to DOM nodes
		const fileToNodeMap = new Map<string, { nodeId: string; nodeEl: HTMLElement }>();
		
		// First, try to use Canvas API nodeViews to map nodes
		if (nodeViews && nodeViews instanceof Map) {
			for (const [nodeId, nodeView] of nodeViews.entries()) {
				if (!nodeView || !nodeView.containerEl) continue;
				
				const nodeData = canvasData.nodes.find((n: any) => n.id === nodeId);
				if (nodeData && nodeData.type === "file") {
					const file = this.plugin.app.vault.getAbstractFileByPath(nodeData.file);
					if (file instanceof TFile) {
						fileToNodeMap.set(file.path, { nodeId, nodeEl: nodeView.containerEl });
					}
				}
			}
		}
		
		// Then, scan DOM nodes and try to match by content or links
		for (const nodeEl of allNodes) {
			const htmlNode = nodeEl as HTMLElement;
			
			// Skip if already mapped via API
			let alreadyMapped = false;
			for (const mapping of fileToNodeMap.values()) {
				if (mapping.nodeEl === htmlNode) {
					alreadyMapped = true;
					break;
				}
			}
			if (alreadyMapped) continue;
			
			// Try to find file links in this node
			const fileLinks = htmlNode.querySelectorAll("a.internal-link, a[data-href], a[href]");
			for (const link of fileLinks) {
				const href = (link as HTMLAnchorElement).getAttribute("href") || 
				             (link as HTMLAnchorElement).getAttribute("data-href");
				if (!href) continue;
				
				// Resolve the file path
				const file = this.plugin.app.metadataCache.getFirstLinkpathDest(href, "");
				if (file instanceof TFile) {
					// Find the node ID from Canvas data
					const nodeData = canvasData.nodes.find((n: any) => n.type === "file" && n.file === file.path);
					if (nodeData && !fileToNodeMap.has(file.path)) {
						fileToNodeMap.set(file.path, { nodeId: nodeData.id, nodeEl: htmlNode });
					}
				}
			}
			
			// Try to match by file title/content
			const textContent = htmlNode.textContent || "";
			for (const node of canvasData.nodes) {
				if (node.type === "file" && !fileToNodeMap.has(node.file)) {
					const file = this.plugin.app.vault.getAbstractFileByPath(node.file);
					if (file instanceof TFile) {
						const fileName = file.basename;
						if (textContent.includes(fileName)) {
							fileToNodeMap.set(file.path, { nodeId: node.id, nodeEl: htmlNode });
							break;
						}
					}
				}
			}
		}

		// Process TaskNote files
		for (const node of canvasData.nodes) {
			if (node.type === "file") {
				const file = this.plugin.app.vault.getAbstractFileByPath(node.file);
				if (file instanceof TFile && this.isTaskFile(file)) {
					const mapping = fileToNodeMap.get(file.path);
					if (mapping) {
						this.replaceNodeWithTaskCard(state, mapping.nodeId, file, mapping.nodeEl);
					} else {
						// Try one more time to find it by iterating all nodes
						let foundNode: HTMLElement | null = null;
						for (const nodeEl of allNodes) {
							const htmlNode = nodeEl as HTMLElement;
							const nodeText = htmlNode.textContent || "";
							if (nodeText.includes(file.basename)) {
								foundNode = htmlNode;
								break;
							}
						}
						
						if (foundNode) {
							this.replaceNodeWithTaskCard(state, node.id, file, foundNode);
						} else {
							// Still try to replace, it might find it later
							this.replaceNodeWithTaskCard(state, node.id, file);
						}
					}
				}
			}
		}
	}

	private async replaceNodeWithTaskCard(
		state: CanvasViewState,
		nodeId: string,
		file: TFile,
		nodeEl?: HTMLElement
	): Promise<void> {
		// Skip if already processed
		if (state.taskNodes.has(nodeId)) {
			// Update existing card instead
			const task = await this.plugin.cacheManager.getTaskInfo(file.path);
			if (task) {
				this.updateTaskCardForNode(state, nodeId, task);
			}
			return;
		}

		const view = state.leaf.view as any;
		if (!view || !view.canvas) return;

		// Get the task info
		const task = await this.plugin.cacheManager.getTaskInfo(file.path);
		if (!task) return;

		// Find the DOM node for this Canvas node if not provided
		if (!nodeEl) {
			const canvasEl = view.canvas.wrapperEl;
			if (!canvasEl) {
				console.warn(`[TaskNotes][Canvas] Canvas wrapper element not found`);
				return;
			}

			// Try to get node view from Canvas API first
			const nodeViews = (view.canvas as any).nodeViews || new Map();
			const nodeView = nodeViews.get(nodeId);
			if (nodeView && nodeView.containerEl) {
				nodeEl = nodeView.containerEl;
			} else {
				// Try multiple selectors to find the Canvas node element
				nodeEl = canvasEl.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement;
				if (!nodeEl) {
					nodeEl = canvasEl.querySelector(`.canvas-node[data-id="${nodeId}"]`) as HTMLElement;
				}
				if (!nodeEl) {
					nodeEl = canvasEl.querySelector(`#canvas-node-${nodeId}`) as HTMLElement;
				}
				if (!nodeEl) {
					// Try finding by file path in the node
					const allNodes = canvasEl.querySelectorAll(".canvas-node");
					for (const node of allNodes) {
						const htmlNode = node as HTMLElement;
						const links = htmlNode.querySelectorAll(`a[href="${file.path}"], a[data-href="${file.path}"]`);
						if (links.length > 0) {
							nodeEl = htmlNode;
							break;
						}
						const internalLinks = htmlNode.querySelectorAll(`a.internal-link[href="${file.path}"], a.internal-link[data-href="${file.path}"]`);
						if (internalLinks.length > 0) {
							nodeEl = htmlNode;
							break;
						}
					}
				}
			}
			
			if (!nodeEl) {
				// Try to find node by file path as fallback
				const allNodes = canvasEl.querySelectorAll(".canvas-node");
				for (const node of allNodes) {
					const htmlNode = node as HTMLElement;
					const fileLinks = htmlNode.querySelectorAll("a.internal-link, a[data-href]");
					for (const link of fileLinks) {
						const href = (link as HTMLAnchorElement).getAttribute("href") || 
						             (link as HTMLAnchorElement).getAttribute("data-href");
						if (!href) continue;
						
						const linkedFile = this.plugin.app.metadataCache.getFirstLinkpathDest(href, "");
						if (linkedFile && linkedFile.path === file.path) {
							nodeEl = htmlNode;
							break;
						}
					}
					if (nodeEl) break;
				}
				
				if (!nodeEl) {
					// Node might not be rendered yet, try again later
					setTimeout(() => {
						this.replaceNodeWithTaskCard(state, nodeId, file);
					}, 1000);
					return;
				}
			}
		}

		// Find the content container within the node
		// Canvas file nodes have different structures for display vs edit mode
		// We want to replace the DISPLAY mode content, not edit mode
		
		// First, try to find the display mode content (markdown preview)
		// Canvas typically uses .markdown-embed-content for the rendered preview
		let contentEl = nodeEl.querySelector(".markdown-embed-content") as HTMLElement;
		
		// If not found, try other common display mode containers
		if (!contentEl) {
			contentEl = nodeEl.querySelector(".markdown-preview-view") as HTMLElement;
		}
		if (!contentEl) {
			contentEl = nodeEl.querySelector(".markdown-preview-section") as HTMLElement;
		}
		if (!contentEl) {
			contentEl = nodeEl.querySelector(".canvas-node-content") as HTMLElement;
		}
		if (!contentEl) {
			contentEl = nodeEl.querySelector(".canvas-node-content-wrapper") as HTMLElement;
		}
		if (!contentEl) {
			// Try finding the markdown embed wrapper (not the editor)
			const markdownEmbed = nodeEl.querySelector(".markdown-embed") as HTMLElement;
			if (markdownEmbed) {
				// Look for preview content within the embed, not editor
				contentEl = markdownEmbed.querySelector(".markdown-preview-view") as HTMLElement ||
				           markdownEmbed.querySelector(".markdown-embed-content") as HTMLElement ||
				           markdownEmbed;
			}
		}
		
		// Make sure we're not targeting the editor (edit mode)
		// Canvas editors typically have .cm-editor or .markdown-source-view classes
		if (contentEl) {
			const isEditor = contentEl.closest(".cm-editor") || 
			                 contentEl.closest(".markdown-source-view") ||
			                 contentEl.classList.contains("cm-editor") ||
			                 contentEl.classList.contains("markdown-source-view");
			if (isEditor) {
				// Don't use editor, find display mode instead
				contentEl = null as any; // Reset to find display mode
			}
		}
		
		if (!contentEl) {
			// Try to find display mode content by excluding editor elements
			const allDivs = nodeEl.querySelectorAll("div");
			for (const div of allDivs) {
				const htmlDiv = div as HTMLElement;
				// Skip if it's part of an editor
				if (htmlDiv.closest(".cm-editor") || htmlDiv.closest(".markdown-source-view")) {
					continue;
				}
				// Look for preview/display content
				if (htmlDiv.classList.contains("markdown-preview-view") ||
				    htmlDiv.classList.contains("markdown-embed-content") ||
				    htmlDiv.classList.contains("markdown-preview-section")) {
					contentEl = htmlDiv;
					break;
				}
			}
		}
		
		if (!contentEl) {
			// Last resort: find the largest non-editor child
			if (nodeEl.children.length > 0) {
				let largestChild: HTMLElement | null = null;
				let largestSize = 0;
				for (const child of Array.from(nodeEl.children)) {
					const htmlChild = child as HTMLElement;
					// Skip editor elements
					if (htmlChild.closest(".cm-editor") || htmlChild.closest(".markdown-source-view")) {
						continue;
					}
					const size = htmlChild.offsetWidth * htmlChild.offsetHeight;
					if (size > largestSize) {
						largestSize = size;
						largestChild = htmlChild;
					}
				}
				if (largestChild) {
					contentEl = largestChild;
				}
			}
			
			if (!contentEl) {
				// Last resort: use the node itself, but only if it's not an editor
				if (!nodeEl.classList.contains("cm-editor") && 
				    !nodeEl.classList.contains("markdown-source-view")) {
					contentEl = nodeEl;
				} else {
					// If we still can't find display mode, wait and try again
					setTimeout(() => {
						this.replaceNodeWithTaskCard(state, nodeId, file, nodeEl);
					}, 500);
					return;
				}
			}
		}

		// For Canvas, always show all properties to ensure interactive features are available
		// Explicitly include status, priority, due, and scheduled to guarantee interactive elements
		const defaultProps = this.plugin.settings.defaultVisibleProperties || [
			"status", "priority", "due", "scheduled", "projects", "contexts"
		];
		const visibleProperties = convertInternalToUserProperties(defaultProps, this.plugin);
		// Ensure status, priority, due, and scheduled are always included
		const statusProp = this.plugin.fieldMapper.toUserField("status");
		const priorityProp = this.plugin.fieldMapper.toUserField("priority");
		const dueProp = this.plugin.fieldMapper.toUserField("due");
		const scheduledProp = this.plugin.fieldMapper.toUserField("scheduled");
		const canvasVisibleProperties = [
			...new Set([statusProp, priorityProp, dueProp, scheduledProp, ...visibleProperties])
		];
		
		const taskCard = createTaskCard(task, this.plugin, canvasVisibleProperties, {
			layout: "default", // Use default layout to include all interactive features
		});

		// Add Canvas-specific styling
		taskCard.addClass("task-card--canvas");

		// Use overlay approach: position task card absolutely over the content
		// This way Canvas can render whatever it wants, but our card stays on top
		if (!nodeEl) return;
		
		// Make the node container relative positioning
		nodeEl.style.position = "relative";
		
		// Style the task card as an overlay
		taskCard.style.position = "absolute";
		taskCard.style.top = "0";
		taskCard.style.left = "0";
		taskCard.style.right = "0";
		taskCard.style.bottom = "0";
		taskCard.style.zIndex = "1000";
		taskCard.style.backgroundColor = "var(--background-primary)";
		taskCard.style.padding = "var(--tn-spacing-sm) var(--tn-spacing-md)";
		taskCard.style.overflow = "auto";
		
		// Hide the markdown content
		const markdownContent = contentEl.querySelector(".markdown-preview-view, .markdown-embed-content, .markdown-preview-section");
		if (markdownContent) {
			(markdownContent as HTMLElement).style.display = "none";
		}
		
		// Remove any existing task card first
		const existingCard = nodeEl.querySelector(".task-card--canvas");
		if (existingCard) {
			existingCard.remove();
		}
		
		// Add the task card to the node, not the content element
		nodeEl.appendChild(taskCard);
		
		// Mark the content element to prevent Canvas from re-rendering
		contentEl.setAttribute("data-tasknotes-replaced", "true");
		
		// Also mark the parent node to prevent Canvas interference
		nodeEl.setAttribute("data-tasknotes-replaced", "true");
		
		// Set up event delegation at the Canvas level to handle clicks
		// This ensures events work even if Canvas is blocking direct event handlers
		const canvasEl = view.canvas.wrapperEl;
		if (canvasEl) {
			this.setupEventDelegation(canvasEl, view);
		}
		
		// Set up a MutationObserver on the parent node to catch when Canvas replaces content
		// Canvas may replace the entire contentEl, so we observe the parent
		const parentNode = contentEl.parentElement || nodeEl;
		if (!parentNode) return;
		
		let reinjectTimer: number | null = null;
		const observer = new MutationObserver(() => {
			// Debounce: only check after a short delay
			if (reinjectTimer) {
				clearTimeout(reinjectTimer);
			}
			reinjectTimer = window.setTimeout(() => {
				// Re-find the content element in case Canvas replaced it
				let currentContentEl = contentEl;
				if (!document.contains(contentEl)) {
					// contentEl was removed, find it again
					const node = nodeEl || parentNode.querySelector(`[data-tasknotes-node-id="${nodeId}"]`)?.closest(".canvas-node");
					if (node) {
						currentContentEl = node.querySelector(".markdown-embed-content") || 
						                   node.querySelector(".markdown-preview-view") ||
						                   node.querySelector(".canvas-node-content") ||
						                   node as HTMLElement;
					} else {
						return; // Can't find the node
					}
				}
				
				// Find the node
				const currentNode = currentContentEl.closest(".canvas-node") as HTMLElement;
				if (!currentNode) {
					reinjectTimer = null;
					return;
				}
				
				const hasCard = currentNode.querySelector(".task-card--canvas");
				if (!hasCard) {
					// Re-inject the card as overlay
					currentNode.style.position = "relative";
					taskCard.style.position = "absolute";
					taskCard.style.top = "0";
					taskCard.style.left = "0";
					taskCard.style.right = "0";
					taskCard.style.bottom = "0";
					taskCard.style.zIndex = "1000";
					taskCard.style.backgroundColor = "var(--background-primary)";
					taskCard.style.padding = "var(--tn-spacing-sm) var(--tn-spacing-md)";
					taskCard.style.overflow = "auto";
					currentNode.appendChild(taskCard);
					currentNode.setAttribute("data-tasknotes-replaced", "true");
					currentContentEl.setAttribute("data-tasknotes-replaced", "true");
				}
				reinjectTimer = null;
			}, 300);
		});

		observer.observe(parentNode, {
			childList: true,
			subtree: true, // Need subtree to catch content element replacement
		});
		
		// Track this node
		const trackedNodeState: CanvasTaskNodeState = {
			nodeId,
			file,
			taskCard,
			contentEl,
			observer,
		};
		state.taskNodes.set(nodeId, trackedNodeState);

	}

	private async updateTaskCardForNode(
		state: CanvasViewState,
		nodeId: string,
		task: TaskInfo
	): Promise<void> {
		const nodeState = state.taskNodes.get(nodeId);
		if (!nodeState) return;

		// Update the task card with new data
		const visibleProperties = this.plugin.settings.defaultVisibleProperties
			? convertInternalToUserProperties(this.plugin.settings.defaultVisibleProperties, this.plugin)
			: undefined;

		updateTaskCard(nodeState.taskCard, task, this.plugin, visibleProperties, {
			layout: "compact",
		});
	}

	private refreshAllCanvasViews(): void {
		for (const state of this.canvasViews.values()) {
			// Refresh all task cards in this Canvas
			for (const [nodeId, nodeState] of state.taskNodes.entries()) {
				this.plugin.cacheManager
					.getTaskInfo(nodeState.file.path)
					.then((task) => {
						if (task) {
							this.updateTaskCardForNode(state, nodeId, task);
						}
					})
					.catch((error) => {
			// Error refreshing task card - silently fail
					});
			}
		}
	}

	private cleanupCanvasView(state: CanvasViewState): void {
		if (state.observer) {
			state.observer.disconnect();
			state.observer = null;
		}

		// Clear interval if it exists
		if ((state as any).intervalId) {
			clearInterval((state as any).intervalId);
			delete (state as any).intervalId;
		}

		// Clean up task cards and their observers
		for (const nodeState of state.taskNodes.values()) {
			if (nodeState.observer) {
				nodeState.observer.disconnect();
			}
			if ((nodeState as any).checkInterval) {
				clearInterval((nodeState as any).checkInterval);
			}
		}

		state.taskNodes.clear();
	}

	/**
	 * Public method to replace Canvas node content via markdown post-processor
	 */
	async replaceCanvasNodeContentViaPostProcessor(
		nodeId: string,
		file: TFile,
		contentEl: HTMLElement
	): Promise<void> {
		// Find the Canvas view state for this node
		let targetState: CanvasViewState | null = null;
		for (const [leaf, state] of this.canvasViews.entries()) {
			const view = state.leaf.view as any;
			if (view?.canvas?.wrapperEl?.contains(contentEl)) {
				targetState = state;
				break;
			}
		}

		if (!targetState) {
			// Canvas view might not be tracked yet, try to find it
			const canvasLeaves = this.plugin.app.workspace.getLeavesOfType("canvas");
			for (const leaf of canvasLeaves) {
				const view = leaf.view as any;
				if (view?.canvas?.wrapperEl?.contains(contentEl)) {
					if (!this.canvasViews.has(leaf)) {
						this.setupCanvasView(leaf);
					}
					targetState = this.canvasViews.get(leaf) || null;
					break;
				}
			}
		}

		if (!targetState) {
			return;
		}

		// Always replace - don't skip if already processed
		// This ensures we re-inject if Canvas removed it

		// Get the task info
		const task = await this.plugin.cacheManager.getTaskInfo(file.path);
		if (!task) return;

		// For Canvas, always show all properties to ensure interactive features are available
		// Explicitly include status, priority, due, and scheduled to guarantee interactive elements
		const defaultProps = this.plugin.settings.defaultVisibleProperties || [
			"status", "priority", "due", "scheduled", "projects", "contexts"
		];
		const visibleProperties = convertInternalToUserProperties(defaultProps, this.plugin);
		// Ensure status, priority, due, and scheduled are always included
		const statusProp = this.plugin.fieldMapper.toUserField("status");
		const priorityProp = this.plugin.fieldMapper.toUserField("priority");
		const dueProp = this.plugin.fieldMapper.toUserField("due");
		const scheduledProp = this.plugin.fieldMapper.toUserField("scheduled");
		const canvasVisibleProperties = [
			...new Set([statusProp, priorityProp, dueProp, scheduledProp, ...visibleProperties])
		];
		
		const taskCard = createTaskCard(task, this.plugin, canvasVisibleProperties, {
			layout: "default", // Use default layout to include all interactive features
		});

		// Add Canvas-specific styling
		taskCard.addClass("task-card--canvas");

		// Use overlay approach: position task card absolutely over the content
		// This way Canvas can render whatever it wants, but our card stays on top
		const nodeEl = contentEl.closest(".canvas-node") as HTMLElement;
		if (!nodeEl) return;
		
		// Make the node container relative positioning
		nodeEl.style.position = "relative";
		
		// Style the task card as an overlay
		taskCard.style.position = "absolute";
		taskCard.style.top = "0";
		taskCard.style.left = "0";
		taskCard.style.right = "0";
		taskCard.style.bottom = "0";
		taskCard.style.zIndex = "1000";
		taskCard.style.backgroundColor = "var(--background-primary)";
		taskCard.style.padding = "var(--tn-spacing-sm) var(--tn-spacing-md)";
		taskCard.style.overflow = "auto";
		
		// Hide the markdown content
		const markdownContent = contentEl.querySelector(".markdown-preview-view, .markdown-embed-content, .markdown-preview-section");
		if (markdownContent) {
			(markdownContent as HTMLElement).style.display = "none";
		}
		
		// Remove any existing task card first
		const existingCard = nodeEl.querySelector(".task-card--canvas");
		if (existingCard) {
			existingCard.remove();
		}
		
		// Add the task card to the node, not the content element
		nodeEl.appendChild(taskCard);

		// Mark the content element to prevent Canvas from re-rendering
		contentEl.setAttribute("data-tasknotes-replaced", "true");
		
		// Mark the parent node
		nodeEl.setAttribute("data-tasknotes-replaced", "true");

		// Track this node
		targetState.taskNodes.set(nodeId, {
			nodeId,
			file,
			taskCard,
			contentEl,
		});

		// Set up event delegation if not already done
		const view = targetState.leaf.view as any;
		const canvasEl = view?.canvas?.wrapperEl;
		if (canvasEl && !(canvasEl as any).__tasknotesEventDelegation) {
			this.setupEventDelegation(canvasEl, view);
		}

		// Set up a MutationObserver on the parent node to catch when Canvas replaces content
		const parentNode = contentEl.parentElement || nodeEl;
		if (parentNode) {
			let reinjectTimer3: number | null = null;
			const observer = new MutationObserver(() => {
				// Debounce: only check after a short delay
				if (reinjectTimer3) {
					clearTimeout(reinjectTimer3);
				}
				reinjectTimer3 = window.setTimeout(() => {
					// Re-find the node in case Canvas replaced it
					let currentNode = nodeEl || contentEl.closest(".canvas-node") as HTMLElement;
					if (!currentNode || !document.contains(currentNode)) {
						currentNode = (parentNode as HTMLElement).querySelector(`[data-tasknotes-node-id="${nodeId}"]`)?.closest(".canvas-node") as HTMLElement;
						if (!currentNode) {
							reinjectTimer3 = null;
							return;
						}
					}
					
					// Re-find content element
					let currentContentEl = contentEl;
					if (!document.contains(contentEl)) {
						currentContentEl = currentNode.querySelector(".markdown-embed-content") || 
						                   currentNode.querySelector(".markdown-preview-view") ||
						                   currentNode.querySelector(".canvas-node-content") ||
						                   currentNode;
					}
					
					// Hide markdown content
					const markdown = currentNode.querySelector(".markdown-preview-view, .markdown-embed-content, .markdown-preview-section");
					if (markdown) {
						(markdown as HTMLElement).style.display = "none";
					}
					
					const hasCard = currentNode.querySelector(".task-card--canvas");
					if (!hasCard) {
						// Get fresh task data and create a new card
						this.plugin.cacheManager.getTaskInfo(file.path).then((currentTask) => {
							if (!currentTask) {
								reinjectTimer3 = null;
								return;
							}
							
							const defaultProps = this.plugin.settings.defaultVisibleProperties || [
								"status", "priority", "due", "scheduled", "projects", "contexts"
							];
							const visibleProperties = convertInternalToUserProperties(defaultProps, this.plugin);
							const statusProp = this.plugin.fieldMapper.toUserField("status");
							const priorityProp = this.plugin.fieldMapper.toUserField("priority");
							const dueProp = this.plugin.fieldMapper.toUserField("due");
							const scheduledProp = this.plugin.fieldMapper.toUserField("scheduled");
							const canvasVisibleProperties = [
								...new Set([statusProp, priorityProp, dueProp, scheduledProp, ...visibleProperties])
							];
							
							const freshTaskCard = createTaskCard(currentTask, this.plugin, canvasVisibleProperties, {
								layout: "default",
							});
							freshTaskCard.addClass("task-card--canvas");
							
							// Style as overlay
							currentNode.style.position = "relative";
							freshTaskCard.style.position = "absolute";
							freshTaskCard.style.top = "0";
							freshTaskCard.style.left = "0";
							freshTaskCard.style.right = "0";
							freshTaskCard.style.bottom = "0";
							freshTaskCard.style.zIndex = "1000";
							freshTaskCard.style.backgroundColor = "var(--background-primary)";
							freshTaskCard.style.padding = "var(--tn-spacing-sm) var(--tn-spacing-md)";
							freshTaskCard.style.overflow = "auto";
							
							currentNode.appendChild(freshTaskCard);
							currentNode.setAttribute("data-tasknotes-replaced", "true");
							currentContentEl.setAttribute("data-tasknotes-replaced", "true");
							
							// Update stored reference
							const nodeState = targetState.taskNodes.get(nodeId);
							if (nodeState) {
								nodeState.taskCard = freshTaskCard;
							}
							
							reinjectTimer3 = null;
						}).catch(() => {
							reinjectTimer3 = null;
						});
					} else {
						reinjectTimer3 = null;
					}
				}, 300);
			});

			observer.observe(parentNode, {
				childList: true,
				subtree: true, // Need subtree to catch content element replacement
			});
			
			// Store observer in node state
			const nodeState = targetState.taskNodes.get(nodeId);
			if (nodeState) {
				nodeState.observer = observer;
			}
		}
	}

	private setupEventDelegation(canvasEl: HTMLElement, view: any): void {
		if ((canvasEl as any).__tasknotesEventDelegation) return;
		(canvasEl as any).__tasknotesEventDelegation = true;
		
		// Use capture phase to catch events before Canvas can block them
		const handleCanvasClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target) return;
			
			// Check if click is on a task card element
			const taskCard = target.closest(".task-card--canvas");
			if (!taskCard) return;
			
			// Handle status dot clicks
			const statusDot = target.closest(".task-card__status-dot") as HTMLElement;
			if (statusDot) {
				e.stopPropagation();
				e.preventDefault();
				// Get the task path from the card
				const taskPath = (taskCard as HTMLElement).dataset.taskPath;
				if (taskPath) {
					this.plugin.cacheManager.getTaskInfo(taskPath).then((taskInfo) => {
						if (taskInfo) {
							// Cycle to next status
							const currentStatus = taskInfo.status;
							const nextStatus = this.plugin.statusManager.getNextStatus(currentStatus);
							this.plugin.updateTaskProperty(taskInfo, "status", nextStatus);
						}
					});
				}
				return;
			}
			
			// Handle priority dot clicks
			const priorityDot = target.closest(".task-card__priority-dot") as HTMLElement;
			if (priorityDot) {
				e.stopPropagation();
				e.preventDefault();
				const taskPath = (taskCard as HTMLElement).dataset.taskPath;
				if (taskPath) {
					this.plugin.cacheManager.getTaskInfo(taskPath).then((taskInfo) => {
						if (taskInfo) {
							// Show priority menu
							import("../components/PriorityContextMenu").then(({ PriorityContextMenu }) => {
								const menu = new PriorityContextMenu({
									currentValue: taskInfo.priority,
									onSelect: async (priority) => {
										await this.plugin.updateTaskProperty(taskInfo, "priority", priority);
									},
									plugin: this.plugin,
								});
								menu.show(e);
							});
						}
					});
				}
				return;
			}
			
			// Handle date clicks
			const dateEl = target.closest("[data-tn-action='edit-date']") as HTMLElement;
			if (dateEl) {
				e.stopPropagation();
				e.preventDefault();
				const taskPath = (taskCard as HTMLElement).dataset.taskPath;
				const dateType = dateEl.dataset.tnDateType as "due" | "scheduled";
				if (taskPath && dateType) {
					this.plugin.cacheManager.getTaskInfo(taskPath).then((taskInfo) => {
						if (taskInfo) {
							import("../components/DateContextMenu").then(({ DateContextMenu }) => {
								import("../utils/dateUtils").then(({ getDatePart, getTimePart }) => {
									const currentValue = dateType === "due" ? taskInfo.due : taskInfo.scheduled;
									const menu = new DateContextMenu({
										currentValue: getDatePart(currentValue || ""),
										currentTime: getTimePart(currentValue || ""),
										onSelect: async (dateValue, timeValue) => {
											let finalValue: string | undefined;
											if (!dateValue) {
												finalValue = undefined;
											} else if (timeValue) {
												finalValue = `${dateValue}T${timeValue}`;
											} else {
												finalValue = dateValue;
											}
											await this.plugin.updateTaskProperty(taskInfo, dateType, finalValue);
										},
										plugin: this.plugin,
									});
									menu.show(e);
								});
							});
						}
					});
				}
				return;
			}
			
			// Handle context menu clicks
			const contextMenu = target.closest(".task-card__context-menu") as HTMLElement;
			if (contextMenu) {
				e.stopPropagation();
				e.preventDefault();
				const taskPath = (taskCard as HTMLElement).dataset.taskPath;
				if (taskPath) {
					import("../ui/TaskCard").then(({ showTaskContextMenu }) => {
						const targetDate = new Date();
						showTaskContextMenu(e, taskPath, this.plugin, targetDate);
					});
				}
				return;
			}
		};
		
		canvasEl.addEventListener("click", handleCanvasClick, true); // Use capture phase
	}

	private isTaskFile(file: TFile): boolean {
		// Get the file's metadata to check frontmatter
		const metadata = this.plugin.app.metadataCache.getFileCache(file);
		if (!metadata?.frontmatter) {
			return false;
		}
		return this.plugin.cacheManager.isTaskFile(metadata.frontmatter);
	}
}

interface CanvasViewState {
	leaf: WorkspaceLeaf;
	observer: MutationObserver | null;
	taskNodes: Map<string, CanvasTaskNodeState>;
}

interface CanvasTaskNodeState {
	nodeId: string;
	file: TFile;
	taskCard: HTMLElement;
	contentEl: HTMLElement;
	observer?: MutationObserver;
}

