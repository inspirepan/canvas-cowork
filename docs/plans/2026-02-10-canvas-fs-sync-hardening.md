# Canvas FS Sync Hardening Implementation Plan

> **For Claude:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** 完成 canvas FS 双向同步的加固：命名去重、图片内容更新同步、图片移动触发 annotation、FS rename/move 识别增强。

**Architecture:** 在客户端维护更完整的文件状态与路径去重逻辑，补齐 FS 事件元信息以提升 move/rename 匹配可靠性，并完善图片资源刷新与 annotation 触发条件。通过小型纯函数拆分与测试保证行为可验证。

**Tech Stack:** Bun, TypeScript, tldraw, WebSocket, fs watch

---

### Task 1: 扩展 FS 事件元信息

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/server/canvas-fs.ts`
- Modify: `src/web/src/canvas/canvas-sync.ts`

**Intent:** 为 rename/move 检测提供可比较的元信息（size/mtime/文本内容），同时在客户端维护已知文件集合。

**Steps:**
1. Write a failing test that verifies FS 事件包含 size/mtime 且在客户端可读取
2. Implement FS event metadata emission (size/mtime for files; optional fields)
3. Implement client-side knownPaths/knownMeta cache and update on init + FS events
4. Verify: `bun test` (or the specific new test file)
5. Commit: `feat: add fs event metadata for sync`

**Acceptance criteria:**
- FS 事件与 initial scan 可提供 size/mtime（文本还包含 content）
- 客户端能维护已知路径集合与元信息缓存

**Notes:** 使用可选字段保持兼容；目录不要求 size/mtime。

---

### Task 2: 画布侧命名去重（create/rename/move）

**Files:**
- Modify: `src/web/src/canvas/canvas-sync.ts`

**Intent:** 在画布发起的创建/重命名/移动时避免路径冲突，自动添加数字后缀并回写形状名称。

**Steps:**
1. Write a failing test for unique-path generation (e.g. `brief.txt` -> `brief-1.txt`)
2. Implement `ensureUniquePath` helper that uses knownPaths + mapping
3. Apply helper to named_text/frame create + rename + reparent/move flows
4. Verify: `bun test`
5. Commit: `feat: dedupe canvas-originated paths`

**Acceptance criteria:**
- 新建/重命名/移动到冲突路径时自动改名并同步更新 shape props
- `shapeToFile`/`fileToShape` 与已知路径集合一致

**Notes:** 去重后应更新 shape 名称，避免 UI 与路径不一致。

---

### Task 3: FS rename/move 检测增强

**Files:**
- Modify: `src/web/src/canvas/canvas-sync.ts`

**Intent:** 在 FS 删除+创建且文件名改变时，依旧识别为 move/rename 并保持形状连续性。

**Steps:**
1. Write failing tests for detectMoves (same ext + size/mtime/content match)
2. Implement enhanced matching logic using metadata/content heuristics
3. Update FS move handling to refresh shape name / asset name when basename changes
4. Verify: `bun test`
5. Commit: `feat: improve fs move/rename detection`

**Acceptance criteria:**
- `mv a.txt b.txt` 不再表现为 delete+create
- rename/move 后形状名称与图片 asset 名称同步更新

**Notes:** 启发式需尽量保守，避免错误合并；在不确定时仍退回 delete+create。

---

### Task 4: 图片内容更新同步 + annotation 触发扩展

**Files:**
- Modify: `src/web/src/canvas/canvas-sync.ts`

**Intent:** 当 FS 修改图片内容时刷新资产显示，并在图片移动/尺寸变化时触发 annotation 检查。

**Steps:**
1. Write failing tests for image FS modified handling (src cache-bust + mapping稳定)
2. Implement image refresh (normalize src, cache-busting, update asset dims as needed)
3. Trigger annotation check on image move/resize/reparent and on image refresh
4. Verify: `bun test`
5. Commit: `feat: sync image updates and annotation triggers`

**Acceptance criteria:**
- 修改图片文件后画布显示刷新
- 图片移动到 draw 覆盖区域会触发 `_annotated.png` 生成/删除

**Notes:** cache-busting 不应污染 `shapeToFile` 映射。

---

### Task 5: 文档与手工回归

**Files:**
- Modify: `docs/canvas-fs-mapping.md`

**Intent:** 更新文档中的限制项与行为说明，并进行关键路径手工验证。

**Steps:**
1. Update docs for new behavior and removed limitations
2. Verify: 手工操作清单（rename、move、image modify、annotation）
3. Commit: `docs: update canvas fs mapping`

**Acceptance criteria:**
- 文档与实现一致，已知问题列表同步更新

**Notes:** 手工回归步骤要覆盖“改名+移动”与“图片内容更新”。