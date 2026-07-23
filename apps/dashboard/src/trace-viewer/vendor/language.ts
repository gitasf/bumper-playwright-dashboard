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
// packages/isomorphic/locatorGenerators.ts (line 23 of 753) — that file is
// almost entirely locator-codegen logic (generating Python/Java/C#/JS
// locator source for the recorder), which our trace model doesn't need.
//
// VENDOR-NOTE: only the `Language` type alias is extracted (verbatim); the
// other ~750 lines (selector parsing, per-language locator stringifiers,
// `asLocator`, etc.) are dropped as UI/codegen-only and out of scope for the
// trace data model.

export type Language = "javascript" | "python" | "java" | "csharp" | "jsonl";
