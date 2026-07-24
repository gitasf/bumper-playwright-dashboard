/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* oxlint-disable no-underscore-dangle, typescript-eslint/no-explicit-any, typescript-eslint/no-unsafe-type-assertion -- vendored verbatim from upstream; kept byte-diffable against microsoft/playwright rather than restyled */
// VENDOR-PROVENANCE: microsoft/playwright, tag v1.61.1,
// packages/isomorphic/protocolFormatter.ts — verbatim runtime logic; only
// the import of `./protocolMetainfo` is repointed at the sibling
// `./protocol-metainfo` in this vendor/ folder.

import { getMetainfo } from "./protocol-metainfo";

export function formatProtocolParam(
  params: Record<string, string> | undefined,
  alternatives: string,
): string | undefined {
  return _formatProtocolParam(params, alternatives)?.replaceAll("\n", "\\n");
}

function _formatProtocolParam(
  params: Record<string, string> | undefined,
  alternatives: string,
): string | undefined {
  if (!params) return undefined;

  for (const name of alternatives.split("|")) {
    if (name === "url") {
      try {
        const urlObject = new URL(params[name]);
        if (urlObject.protocol === "data:") return urlObject.protocol;
        if (["about:", "chrome:", "edge:"].includes(urlObject.protocol))
          return params[name];
        return urlObject.pathname + urlObject.search;
      } catch {
        if (params[name] !== undefined) return params[name];
      }
    }
    if (name === "timeNumber" && params[name] !== undefined) {
      return new Date(params[name]).toString();
    }

    const value = deepParam(params, name);
    if (value !== undefined) return value;
  }
}

function deepParam(
  params: Record<string, any>,
  name: string,
): string | undefined {
  const tokens = name.split(".");
  let current = params;
  for (const token of tokens) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[token];
  }
  if (current === undefined) return undefined;
  // oxlint-disable-next-line typescript-eslint/no-base-to-string -- vendored verbatim from upstream: `current` may legitimately be a nested object at this point (deep param drill-down), and upstream intentionally stringifies whatever it finds for display purposes.
  return String(current);
}

export function renderTitleForCall(metadata: {
  title?: string;
  type: string;
  method: string;
  params: Record<string, string> | undefined;
}) {
  const titleFormat =
    metadata.title ?? getMetainfo(metadata)?.title ?? metadata.method;
  return titleFormat.replace(/\{([^}]+)\}/g, (fullMatch, p1) => {
    return formatProtocolParam(metadata.params, p1) ?? fullMatch;
  });
}

export type ActionGroup = "configuration" | "route" | "getter";

export function getActionGroup(metadata: { type: string; method: string }) {
  return getMetainfo(metadata)?.group as undefined | ActionGroup;
}
