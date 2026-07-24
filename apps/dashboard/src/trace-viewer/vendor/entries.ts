/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// VENDOR-PROVENANCE: microsoft/playwright, tag v1.61.1. As of this tag, the
// file the task brief calls `packages/trace-viewer/src/types/entries.ts`
// (the pre-refactor location) has moved to
// `packages/isomorphic/trace/entries.ts` — trace-viewer/src/types/ no longer
// exists in this tag; the *Entry types now live in the shared `isomorphic`
// package so both the trace-viewer UI and the service worker's own model
// code can import them. Content is verbatim; only import paths are adapted
// to this vendor/ folder ('@trace/snapshot' -> './snapshot',
// '@trace/trace' -> './trace', '../locatorGenerators' -> './language').
//
// This is the shape of the JSON the service worker's `contexts?trace=`
// endpoint returns (an array of ContextEntry, one per recorded
// BrowserContext, aka "contextEntries" — see bridge.html / use-trace-model.ts
// in this app, which already type against `ContextEntry[]` from this file).

import type { Language } from "./language";
import type { ResourceSnapshot } from "./snapshot";
import type * as trace from "./trace";

// *Entry structures are used to pass the trace between the sw and the page.

export type ContextEntry = {
  origin: "testRunner" | "library";
  startTime: number;
  endTime: number;
  browserName: string;
  channel?: string;
  platform?: string;
  playwrightVersion?: string;
  wallTime: number;
  sdkLanguage?: Language;
  testIdAttributeName?: string;
  title?: string;
  options: trace.BrowserContextEventOptions;
  pages: PageEntry[];
  resources: ResourceSnapshot[];
  actions: ActionEntry[];
  events: (trace.EventTraceEvent | trace.ConsoleMessageTraceEvent)[];
  stdio: trace.StdioTraceEvent[];
  errors: trace.ErrorTraceEvent[];
  hasSource: boolean;
  contextId: string;
  testTimeout?: number;
};

export type PageEntry = {
  pageId: string;
  screencastFrames: {
    sha1: string;
    timestamp: number;
    frameSwapWallTime?: number;
    width: number;
    height: number;
  }[];
};

export type ActionEntry = trace.ActionTraceEvent & {
  log: { time: number; message: string }[];
};
