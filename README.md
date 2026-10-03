# 船舶危险货箱配载审定服务 (Stowage Approval Service)

基于 **TypeScript / Node.js / Express / PostgreSQL** 的航次危险货箱配载审定服务：

- 为航次登记三维舱位网格（bay × row × tier）、各列承重上限、集装箱（箱号 / 重量 / 危险品类别）；
- 设定不相容类别对之间的**最小曼哈顿距离**（正整数）；未设定的类别对视为相容；
- 调度员携带所见修订号**整批**调整箱位（同批允许交换、允许把箱移回未配位状态），仅按**最终布局**校验；
- 任一规则违反则**整批拒绝**，并指出相关箱号、舱位与原因；
- 签发装载清单时所有箱须已配位；签发内容**冻结**当前布局；后续调整产生新修订，旧清单保留；
- 通过行级锁 + 乐观修订号保证：并发调整与签发**不会产生指向过期布局的当前清单**。

## 一键启动

```bash
docker compose up --build
```

- 服务地址：**http://localhost:3000**（健康检查 `GET /health`）
- PostgreSQL：`localhost:5432`（用户/密码/库名均为 `stowage`，数据保存在 `dbdata` 卷中）

Compose 会完成依赖安装（镜像构建时 `npm ci`）、数据库初始化（应用启动时自动建表，幂等）并启动服务；
应用启动时会等待数据库就绪（最多重试 30 次），无需手工初始化。

停止并清空数据：`docker compose down -v`

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `DATABASE_URL` | `postgres://stowage:stowage@localhost:5432/stowage` | PostgreSQL 连接串 |
| `PG_POOL_SIZE` | `10` | 连接池大小 |

## 本地开发

```bash
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 单元测试（布局校验）+ 集成测试（pg-mem 内存库跑真实 HTTP 流程）
npm start          # 需要 DATABASE_URL 指向可用的 PostgreSQL
```

## 坐标与概念约定

- 舱位坐标 `{x, y, z}` 均为 **0 起始整数**，范围 `0 ≤ x < dims.x` 等；**z = 0 为底层**。
- **列** = 同一 `(x, y)` 的竖直堆叠；列占用必须自底向上连续（占用层恰好为 `0..k-1`，不允许悬空/空洞）。
- 列承重上限按 `(x, y)` 登记；**未登记上限的列不限重**。
- 箱位可暂留空：已登记但未配位的箱 `position = null`；批次中 `position: null` 表示把箱移回未配位。
- **修订号（revision）**：每次成功的整批调整 +1。调整必须携带 `expectedRevision`（调度员所见的修订号），
  不一致返回 `409 STALE_REVISION`。签发清单可选带 `expectedRevision` 做同样的保护。
- 曼哈顿距离：`|x1-x2| + |y1-y2| + |z1-z2|`，不相容类别对的实际距离须 **≥** 设定的最小距离。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/voyages` | 登记航次：`{id?, dims:{x,y,z}}` |
| `GET` | `/voyages/:id` | 航次当前状态（含修订号、布局、清单摘要、`currentLoadList`） |
| `PUT` | `/voyages/:id/columns` | 批量登记/更新列承重上限 `{columns:[{x,y,maxWeight}]}` |
| `PUT` | `/voyages/:id/containers` | 批量登记/更新集装箱 `{containers:[{containerNo,weight,dgClass}]}` |
| `PUT` | `/voyages/:id/incompatibilities` | 批量登记不相容类别对 `{pairs:[{classA,classB,minDistance}]}` |
| `POST` | `/voyages/:id/assignments` | 整批调整箱位 `{expectedRevision, moves:[{containerNo, position|null}]}` |
| `POST` | `/voyages/:id/load-list` | 签发装载清单 `{expectedRevision?}`，冻结当前布局 |
| `GET` | `/voyages/:id/load-lists` | 已签发清单列表（旧清单全部保留） |
| `GET` | `/voyages/:id/load-lists/:listId` | 某份冻结清单的完整内容 |

### 最终布局校验规则（任一违反 → 整批拒绝，HTTP 422）

| 规则 | 说明 |
|---|---|
| `POSITION_OCCUPIED` | 一位至多一箱：同一舱位被多个箱占用 |
| `COLUMN_GAP` | 列未自底向上连续占用（悬空或中间有空洞） |
| `COLUMN_OVERWEIGHT` | 列总重超过该列上限 |
| `INCOMPATIBLE_DISTANCE` | 不相容类别对的实际曼哈顿距离小于要求 |

“一箱至多一位”由数据模型保证（每箱至多一个箱位），同批重复出现同一箱号会以
`400 DUPLICATE_CONTAINER_IN_BATCH` 拒绝。校验只针对**批次应用后的最终布局**，因此同批交换合法。

### 错误格式

```json
{
  "error": {
    "code": "LAYOUT_VIOLATION",
    "message": "batch rejected: 2 violation(s)",
    "details": {
      "violations": [
        {
          "rule": "COLUMN_OVERWEIGHT",
          "message": "column (0,0) total weight 34 exceeds limit 30",
          "containers": ["MSKU001", "MSKU002", "MSKU003"],
          "positions": [{"x":0,"y":0,"z":0}, {"x":0,"y":0,"z":1}, {"x":0,"y":0,"z":2}],
          "column": {"x": 0, "y": 0},
          "totalWeight": 34,
          "maxWeight": 30
        }
      ]
    }
  }
}
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `STALE_REVISION` | 409 | 过期修订号（响应含 `currentRevision`） |
| `UNKNOWN_CONTAINER` | 400 | 批次引用未登记的箱号 |
| `INVALID_POSITION` | 400 | 坐标越界 / 非整数 / 缺分量 |
| `INVALID_WEIGHT` | 400 | 重量非正数或非法 |
| `DUPLICATE_CONTAINER_IN_BATCH` | 400 | 同批同一箱号出现多次 |
| `LAYOUT_VIOLATION` | 422 | 最终布局违反规则（含全部违规明细） |
| `UNASSIGNED_CONTAINERS` | 422 | 签发时仍有箱未配位 |
| `VOYAGE_NOT_FOUND` / `LOAD_LIST_NOT_FOUND` | 404 | 航次 / 清单不存在 |
| `VOYAGE_EXISTS` | 409 | 航次 ID 重复 |

## 并发与一致性设计

- **整批调整**与**签发**在同一事务内先 `SELECT ... FOR UPDATE` 锁定航次行，二者因此被串行化：
  签发读到的布局与写入清单的修订号必然一致，**不可能产生指向过期布局的当前清单**。
- 调整采用乐观并发：携带 `expectedRevision`，不匹配即 `409`，整批不落地。
- 清单内容（布局快照 + 修订号）写入后不可变；后续调整只增加航次修订号，旧清单原样保留。
- `GET /voyages/:id` 的 `currentLoadList` 仅当最新清单的修订号等于当前修订号时非空，
  否则为 `null`（表示当前布局尚未签发清单）。

## 调用示例

完整可运行示例（涵盖登记、违规拒绝、交换、签发、旧清单保留）：

```bash
./examples/demo.sh                 # 默认 http://localhost:3000
./examples/demo.sh http://host:port
```

最小流程：

```bash
# 1. 登记航次（3x2x3 舱位网格）
curl -s -X POST localhost:3000/voyages -H 'content-type: application/json' \
  -d '{"id":"VOY-001","dims":{"x":3,"y":2,"z":3}}'

# 2. 登记列承重上限
curl -s -X PUT localhost:3000/voyages/VOY-001/columns -H 'content-type: application/json' \
  -d '{"columns":[{"x":0,"y":0,"maxWeight":30}]}'

# 3. 登记集装箱
curl -s -X PUT localhost:3000/voyages/VOY-001/containers -H 'content-type: application/json' \
  -d '{"containers":[{"containerNo":"MSKU001","weight":12,"dgClass":"3"},
                     {"containerNo":"MSKU002","weight":12,"dgClass":"5.1"}]}'

# 4. 设定不相容类别对：3 与 5.1 最小曼哈顿距离 2
curl -s -X PUT localhost:3000/voyages/VOY-001/incompatibilities -H 'content-type: application/json' \
  -d '{"pairs":[{"classA":"3","classB":"5.1","minDistance":2}]}'

# 5. 整批配位（携带所见修订号 0）
curl -s -X POST localhost:3000/voyages/VOY-001/assignments -H 'content-type: application/json' \
  -d '{"expectedRevision":0,"moves":[
        {"containerNo":"MSKU001","position":{"x":0,"y":0,"z":0}},
        {"containerNo":"MSKU002","position":{"x":2,"y":1,"z":0}}]}'

# 6. 签发装载清单（冻结当前布局）
curl -s -X POST localhost:3000/voyages/VOY-001/load-list -H 'content-type: application/json' -d '{}'
```

## 项目结构

```
src/
  index.ts        入口：等待数据库、建表、启动 HTTP 服务
  app.ts          Express 路由与事务编排（行锁 + 修订号检查）
  db.ts           连接池、启动重试、幂等建表
  validation.ts   最终布局校验（纯函数，收集全部违规）
  types.ts        领域类型
test/
  validation.test.ts    布局规则单元测试
  integration.test.ts   pg-mem 内存库上的端到端 HTTP 测试
examples/demo.sh  完整调用示例
Dockerfile / docker-compose.yml
```
