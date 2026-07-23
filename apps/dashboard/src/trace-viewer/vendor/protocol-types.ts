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

// VENDOR-PROVENANCE: microsoft/playwright, tag v1.61.1,
// packages/protocol/src/channels.d.ts — this is a single generated file
// (5500+ lines covering the whole Playwright wire protocol: browsers, pages,
// frames, workers, Android, Electron, tracing, etc). ../trace.ts only needs
// three tiny, leaf, dependency-free type aliases out of it.
//
// VENDOR-NOTE: rather than vendor the entire generated channels.d.ts, this
// file extracts just `StackFrame`, `Point`, and `SerializedError` verbatim
// (byte-for-byte, at lines 5343-5370 of the source) and drops everything
// else (all RPC channel/params/result/event types). No logic, pure data
// shape — safe to lift in isolation.

export type SerializedValue = {
  n?: number;
  b?: boolean;
  s?: string;
  v?: "null" | "undefined" | "NaN" | "Infinity" | "-Infinity" | "-0";
  d?: string;
  u?: string;
  bi?: string;
  ta?: {
    // VENDOR-NOTE: source type is `Binary` (a base64-string branded type
    // declared elsewhere in channels.d.ts). Nothing in this vendor/ tree
    // reads `SerializedValue.ta`, so it's stubbed as `unknown` rather than
    // pulling in the branding machinery.
    b: unknown;
    k:
      | "i8"
      | "ui8"
      | "ui8c"
      | "i16"
      | "ui16"
      | "i32"
      | "ui32"
      | "f32"
      | "f64"
      | "bi64"
      | "bui64";
  };
  e?: {
    m: string;
    n: string;
    s: string;
  };
  r?: {
    p: string;
    f: string;
  };
  a?: SerializedValue[];
  o?: {
    k: string;
    v: SerializedValue;
  }[];
  h?: number;
  id?: number;
  ref?: number;
};

export type SerializedError = {
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
  value?: SerializedValue;
};

export type StackFrame = {
  file: string;
  line: number;
  column: number;
  function?: string;
};

export type Point = {
  x: number;
  y: number;
};
