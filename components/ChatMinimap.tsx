"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import styles from "./ChatMinimap.module.css";

/** One row of the question directory: a user message on the active branch. */
export interface MinimapQuestion {
  entryId: string;
  preview: string;
}

interface Props {
  /** Every question on the active branch, oldest first. Comes from the session,
   *  not from the loaded chat window, so it stays complete. */
  questions: MinimapQuestion[];
  /** The chat scroller: the rail spans its height and follows its scroll position. */
  scrollContainer: RefObject<HTMLDivElement | null>;
  /** The rendered message list inside the scroller, read through `data-entry-id`. */
  messageList: RefObject<HTMLDivElement | null>;
  onJumpToQuestion: (entryId: string) => void;
}

const MINIMAP_WIDTH = 36;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
const PREVIEW_HIDE_DELAY = 250;
const NAVIGATION_ACTIVE_LOCK_MS = 1600;

interface NodeInfo {
  index: number;
  entryId: string;
  preview: string;
  /** Absolute offset inside the scroller, or null while the message is not rendered. */
  scrollTop: number | null;
}

interface PositionedNode extends NodeInfo {
  topRatio: number;
}

interface NodeLayout {
  nodes: PositionedNode[];
  gap: number;
}

export function layoutNodes(nodes: NodeInfo[], minimapHeight: number): NodeLayout {
  if (nodes.length === 0) return { nodes: [], gap: MAX_NODE_GAP };

  const height = Math.max(1, minimapHeight);
  if (nodes.length === 1) {
    return { nodes: [{ ...nodes[0], topRatio: MINIMAP_PADDING / height }], gap: MAX_NODE_GAP };
  }

  const gap = Math.min(MAX_NODE_GAP, Math.max(0, height - MINIMAP_PADDING * 2) / (nodes.length - 1));
  return {
    nodes: nodes.map((node, index) => ({ ...node, topRatio: (MINIMAP_PADDING + index * gap) / height })),
    gap,
  };
}

/**
 * Which node a pointer position on the rail refers to.
 *
 * Always answers with the nearest node. With only a few questions the nodes sit
 * close together near the top, and the rest of the rail used to be dead space:
 * hovering there did nothing, so the rail stopped following the pointer exactly
 * where the user was pointing.
 */
export function nearestQuestionIndex(
  nodes: PositionedNode[],
  gap: number,
  minimapHeight: number,
  pointerRatio: number,
): number | null {
  if (nodes.length === 0 || minimapHeight <= 0) return null;
  if (nodes.length === 1) return 0;

  const pointerY = Math.max(0, Math.min(minimapHeight, pointerRatio * minimapHeight));
  const rawIndex = gap > 0 ? Math.round((pointerY - MINIMAP_PADDING) / gap) : 0;
  return Math.max(0, Math.min(nodes.length - 1, rawIndex));
}

/** Where on the rail a pointer is, as 0..1 from the top. */
export function pointerRatioOf(clientY: number, element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
}

export function ChatMinimap({
  questions,
  scrollContainer,
  messageList,
  onJumpToQuestion,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [hovered, setHovered] = useState(false);
  const [pointerRatio, setPointerRatio] = useState<number | null>(null);
  const pressedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLockRef = useRef<{ index: number; until: number } | null>(null);
  const questionsRef = useRef(questions);
  questionsRef.current = questions;

  const layout = useMemo(() => layoutNodes(nodes, minimapHeight), [nodes, minimapHeight]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const lockActiveNode = useCallback((index: number) => {
    activeLockRef.current = { index, until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeLockRef.current = null;

    const measured = nextNodes.filter((node) => node.scrollTop !== null);
    if (measured.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nearest = measured.reduce((best, node) => (
      Math.abs((node.scrollTop ?? 0) - focusTop) < Math.abs((best.scrollTop ?? 0) - focusTop) ? node : best
    ), measured[0]);
    setActiveIndex(nearest.index);
  }, []);

  /**
   * Read each question's position out of the rendered message list.
   *
   * The list is keyed by `data-entry-id`, so a question that is not loaded — or
   * not rendered because the visible window is capped — has no offset, instead of
   * shifting every other position the way positional refs did.
   */
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      const minimapEl = containerRef.current;
      if (!scrollEl || !minimapEl) return;

      const renderedByEntryId = new Map<string, HTMLElement>();
      for (const child of messageList.current?.children ?? []) {
        if (child instanceof HTMLElement && child.dataset.entryId) {
          renderedByEntryId.set(child.dataset.entryId, child);
        }
      }

      const containerRect = scrollEl.getBoundingClientRect();
      const nextNodes: NodeInfo[] = questionsRef.current.map((question, index) => {
        const rect = renderedByEntryId.get(question.entryId)?.getBoundingClientRect();
        return {
          index,
          entryId: question.entryId,
          preview: question.preview,
          scrollTop: rect ? rect.top - containerRect.top + scrollEl.scrollTop : null,
        };
      });

      setMinimapHeight(minimapEl.clientHeight);
      setNodes(nextNodes);
      syncActiveNode(scrollEl, nextNodes);
    }, 150);
  }, [messageList, scrollContainer, syncActiveNode]);

  /** Whether the rail has anything to indicate: it needs a scrollable chat, and
   *  its presence must not depend on measuring, because the rail is what gets
   *  measured — it is not in the DOM until this says so. */
  const syncVisible = useCallback((scrollEl: HTMLDivElement | null = scrollContainer.current) => {
    if (!scrollEl) return;
    setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
  }, [scrollContainer]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => {
      syncVisible(el);
      syncActiveNode(el, nodesRef.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainer, syncActiveNode, syncVisible]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const sync = () => {
      syncVisible(el);
      measureNodes();
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    sync();
    return () => {
      observer.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [measureNodes, scrollContainer, syncVisible]);

  // A new directory — another branch, a new question, more of the chat rendered —
  // has to be measured before the rail can show it. `visible` is in here because
  // the rail only exists after it turns true.
  useEffect(() => {
    if (visible) measureNodes();
  }, [measureNodes, questions, visible]);

  const nearestIndex = pointerRatio === null
    ? null
    : nearestQuestionIndex(layout.nodes, layout.gap, minimapHeight, pointerRatio);
  const nearestNode = nearestIndex === null ? null : layout.nodes[nearestIndex];

  const jumpToNearest = useCallback((clientY: number, rail: HTMLElement) => {
    const rect = rail.getBoundingClientRect();
    if (rect.height <= 0) return;
    const height = containerRef.current?.clientHeight ?? 0;
    const index = nearestQuestionIndex(
      layoutRef.current.nodes,
      layoutRef.current.gap,
      height,
      (clientY - rect.top) / rect.height,
    );
    if (index === null) return;
    const node = layoutRef.current.nodes[index];
    lockActiveNode(node.index);
    onJumpToQuestion(node.entryId);
  }, [lockActiveNode, onJumpToQuestion]);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback(() => {
    cancelPreviewHide();
    setHovered(true);
  }, [cancelPreviewHide]);

  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      setHovered(false);
      setPointerRatio(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;
    pressedRef.current = true;
    showPreview();
    setPointerRatio(pointerRatioOf(event.clientY, event.currentTarget));
  }, [showPreview, visible]);

  // The jump happens on release rather than on press so that dragging along the
  // rail only moves the highlight: every jump may have to load history, and a
  // drag across a directory of 40 questions would otherwise fire 40 loads.
  const handleMouseUp = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    jumpToNearest(event.clientY, event.currentTarget);
  }, [jumpToNearest]);

  // Keep the row the pointer refers to inside the visible part of the list.
  useEffect(() => {
    if (!hovered || nearestIndex === null) return;
    const previewBox = previewBoxRef.current;
    const previewItem = previewItemRefs.current.get(nearestIndex);
    if (!previewBox || !previewItem) return;
    const targetTop = previewItem.offsetTop - (previewBox.clientHeight - previewItem.offsetHeight) / 2;
    previewBox.scrollTop = Math.max(0, targetTop);
  }, [hovered, nearestIndex, nodes]);

  if (!visible || questions.length === 0) return null;

  const lastNodeTop = layout.nodes.length > 0
    ? layout.nodes[layout.nodes.length - 1].topRatio * minimapHeight
    : MINIMAP_PADDING;
  const railHeight = Math.max(1, lastNodeTop - MINIMAP_PADDING);
  const jumpToRow = (node: NodeInfo) => {
    lockActiveNode(node.index);
    onJumpToQuestion(node.entryId);
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseEnter={showPreview}
      onMouseLeave={() => {
        pressedRef.current = false;
        schedulePreviewHide();
      }}
      onMouseMove={(event) => setPointerRatio(pointerRatioOf(event.clientY, event.currentTarget))}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "pointer",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: MINIMAP_PADDING,
          height: railHeight,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {layout.nodes.map((node) => {
        const isNearest = hovered && nearestNode === node;
        const isActive = activeIndex === node.index;

        return (
          <div
            key={node.entryId}
            data-minimap-node-index={node.index}
            data-minimap-node-active={isActive ? "" : undefined}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: Math.max(1, layout.gap),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: isActive ? "rgba(128,128,128,0.42)" : "rgba(128,128,128,0.16)",
                border: `1.5px solid ${isActive ? "rgba(128,128,128,0.95)" : "rgba(128,128,128,0.58)"}`,
                boxShadow: isActive ? "0 0 0 2px var(--bg-panel)" : "none",
                transition: "transform 0.1s, background 0.1s",
                transform: isNearest ? "scale(1.25)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      {hovered && layout.nodes.length > 0 && (
        <div
          ref={previewBoxRef}
          className={styles.preview}
          data-minimap-preview-box=""
          onMouseEnter={showPreview}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onMouseMove={(event) => event.stopPropagation()}
        >
          {layout.nodes.map((node) => (
            <div
              key={node.entryId}
              ref={(element) => {
                if (element) previewItemRefs.current.set(node.index, element);
                else previewItemRefs.current.delete(node.index);
              }}
              className={styles.turn}
              data-minimap-preview-index={node.index}
              data-located={nearestNode === node ? "true" : undefined}
            >
              <span className={styles.number} aria-hidden="true">
                {String(node.index + 1).padStart(2, "0")}
              </span>
              <button
                type="button"
                className={styles.user}
                data-minimap-preview-user={node.index}
                onClick={() => jumpToRow(node)}
              >
                <span className={styles.userText}>{node.preview}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
