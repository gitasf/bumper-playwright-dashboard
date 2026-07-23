"use client";

import { useEffect, useMemo } from "react";
import { actionParamHint, actionTitle } from "./model";
import { useModelScopedState } from "./use-model-scoped-state";
import type { ActionTreeItem, TraceModel } from "./vendor/model-util";

function hasErrorInSubtree(item: ActionTreeItem): boolean {
  if (item.action.error?.message) return true;
  return item.children.some((child) => hasErrorInSubtree(child));
}

function computeDefaultCollapsed(
  rootItem: ActionTreeItem,
): ReadonlySet<string> {
  const collapsed = new Set<string>();
  const walk = (item: ActionTreeItem): void => {
    for (const child of item.children) {
      if (child.children.length > 0 && !hasErrorInSubtree(child)) {
        collapsed.add(child.id);
      }
      walk(child);
    }
  };
  walk(rootItem);
  return collapsed;
}

function isEffectivelyCollapsed(
  defaultCollapsed: ReadonlySet<string>,
  overrides: ReadonlySet<string>,
  id: string,
): boolean {
  // Manual overrides invert, rather than replace, the computed default.
  return defaultCollapsed.has(id) !== overrides.has(id);
}

function ancestorChain(item: ActionTreeItem): ActionTreeItem[] {
  const chain: ActionTreeItem[] = [];
  for (let cur = item.parent; cur && cur.id !== ""; cur = cur.parent) {
    chain.push(cur);
  }
  return chain;
}

export type ActionTreeRow = { item: ActionTreeItem; depth: number };

export function useActionTreeCollapse({
  rootItem,
  itemMap,
  model,
  selectedCallId,
  query,
}: {
  rootItem: ActionTreeItem;
  itemMap: Map<string, ActionTreeItem>;
  model: TraceModel;
  selectedCallId: string | undefined;
  query: string;
}): {
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  visibleRows: ActionTreeRow[];
} {
  const defaultCollapsed = useMemo(
    () => computeDefaultCollapsed(rootItem),
    [rootItem],
  );
  const [overrides, setOverrides] = useModelScopedState<
    TraceModel,
    ReadonlySet<string>
  >(model, () => new Set());

  const isCollapsed = (id: string): boolean =>
    isEffectivelyCollapsed(defaultCollapsed, overrides, id);

  useEffect(() => {
    if (!selectedCallId) return;
    const item = itemMap.get(selectedCallId);
    if (!item) return;
    const ancestors = ancestorChain(item);
    if (ancestors.length === 0) return;
    setOverrides((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const ancestor of ancestors) {
        const effectivelyCollapsed = isEffectivelyCollapsed(
          defaultCollapsed,
          next,
          ancestor.id,
        );
        if (!effectivelyCollapsed) continue;
        if (next.has(ancestor.id)) next.delete(ancestor.id);
        else next.add(ancestor.id);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedCallId, itemMap, defaultCollapsed, setOverrides]);

  const toggle = (id: string): void => {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleRows = useMemo(() => {
    const rows: ActionTreeRow[] = [];
    const needle = query.trim().toLowerCase();

    if (!needle) {
      const walk = (item: ActionTreeItem, depth: number): void => {
        for (const child of item.children) {
          rows.push({ item: child, depth });
          if (!isEffectivelyCollapsed(defaultCollapsed, overrides, child.id)) {
            walk(child, depth + 1);
          }
        }
      };
      walk(rootItem, 0);
      return rows;
    }

    const matches = (item: ActionTreeItem): boolean =>
      `${actionTitle(item.action)} ${actionParamHint(item.action)}`
        .toLowerCase()
        .includes(needle);
    const hasMatch = new Map<ActionTreeItem, boolean>();
    const mark = (item: ActionTreeItem): boolean => {
      let any = matches(item);
      for (const child of item.children) any = mark(child) || any;
      hasMatch.set(item, any);
      return any;
    };
    for (const child of rootItem.children) mark(child);
    const walk = (item: ActionTreeItem, depth: number): void => {
      for (const child of item.children) {
        if (!hasMatch.get(child)) continue;
        rows.push({ item: child, depth });
        walk(child, depth + 1);
      }
    };
    walk(rootItem, 0);
    return rows;
  }, [rootItem, defaultCollapsed, overrides, query]);

  return { isCollapsed, toggle, visibleRows };
}
