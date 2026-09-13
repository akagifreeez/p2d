/**
 * P2D - 配信木の割り当てコア (配信木計画書 §3.1/§3.3/§3.4, M1/M3)
 *
 * 根=ホスト、内部ノード=子を引き受けた視聴者(sub-relay)。
 * - fan-out上限: ホスト k=4 / 中継視聴者 k'=2
 * - 深さ上限 D=3 (遅延の積み増しを抑える)
 * - 割り当ては幅優先 (浅いノードから満たす)
 * - 中継者消失時は subtree を一括で孤児化し、幅優先の空きスロットへ再割り当て
 *
 * Reactに依存しない純関数。10ノード割り当てシミュレーション等の単体テスト対象
 * (node --import tsx --test)。
 */

export const ROOT_FANOUT = 4;
export const RELAY_FANOUT = 2;
export const MAX_DEPTH = 3; // 根=深さ0

/** 中継ノードの住所 (自分の内蔵サーバー)。null = 根直結 */
export interface RelayAddr {
    host: string;
    port: number;
}

export interface TreeCap {
    fanout: number;
}

export interface TreeNode {
    id: string;
    addr: RelayAddr | null; // このノードの内蔵サーバー住所 (中継能力を持つなら)
    depth: number;
    fanout: number; // このノードが受け入れられる子の数
    children: TreeNode[];
}

export function createRoot(id: string, rootFanout = ROOT_FANOUT): TreeNode {
    return { id, addr: null, depth: 0, fanout: rootFanout, children: [] };
}

/** ノードIDから subtree を探す (根を含む) */
export function findNode(root: TreeNode, id: string): TreeNode | null {
    if (root.id === id) return root;
    for (const c of root.children) {
        const hit = findNode(c, id);
        if (hit) return hit;
    }
    return null;
}

/** 木全体をフラット化 (デバッグ/テスト用) */
export function flatten(root: TreeNode): TreeNode[] {
    const out: TreeNode[] = [root];
    for (const c of root.children) out.push(...flatten(c));
    return out;
}

/**
 * 新ノードの親を幅優先で決める (空きスロットのある最浅ノード)。
 * 同一深さでは children 追加順 (古いノード優先)。
 * 見つからない (満杯/深さ上限) なら null。
 */
export function pickParent(root: TreeNode, maxDepth = MAX_DEPTH): TreeNode | null {
    const queue: TreeNode[] = [root];
    while (queue.length > 0) {
        const node = queue.shift()!;
        if (node.children.length < node.fanout && node.depth + 1 <= maxDepth) {
            return node;
        }
        queue.push(...node.children);
    }
    return null;
}

/**
 * 新ノードを木に追加する。親は pickParent で決める (呼び出し側は事前に
 * pickParent で親を決め、その親の住所を新ノードへ案内する)。
 * 戻り値: 追加されたノード (親が見つからなければ null)
 */
export function attach(
    root: TreeNode,
    newNode: TreeNode,
    maxDepth = MAX_DEPTH,
): TreeNode | null {
    const parent = pickParent(root, maxDepth);
    if (!parent) return null;
    // 新ノードは fanout=0 (視聴者) で加入 — promoteされて初めて子を引き受ける
    const node: TreeNode = { ...newNode, depth: parent.depth + 1, fanout: 0 };
    parent.children.push(node);
    return node;
}

/**
 * 指定した親の下へ明示配置する (テスト/再割り当ての内部用)。
 * 深さは親から自動計算される。
 */
export function attachUnder(
    root: TreeNode,
    parentId: string,
    newNode: TreeNode,
): TreeNode | null {
    const parent = findNode(root, parentId);
    if (!parent) return null;
    const node: TreeNode = { ...newNode, depth: parent.depth + 1, fanout: 0 };
    parent.children.push(node);
    return node;
}

/**
 * ノード喪失の処理 (peer:left / tree:child_lost 共用)。
 * - root直結の子 (leaf) → 削除
 * - root直結の中継 → subtreeごと解放 (孤児を返す: 再割り当て対象)
 * - 中継配下のノード → その中継の管理領域なのでここでは触らない (空配列)
 *   ※中継配下は中継が tree:child_lost で報告してくる
 */
export function handleNodeLoss(root: TreeNode, lostId: string): TreeNode[] {
    const lost = findNode(root, lostId);
    if (!lost || lost === root) return [];
    if (root.children.some(c => c.id === lostId)) {
        return detachSubtree(root, lostId);
    }
    return [];
}

/**
 * 中継ノードを昇格させる (子を引き受けられるようにする)。
 * fan-outは§3.1どおり中継視聴者は2。
 */
export function promote(node: TreeNode, addr: RelayAddr, fanout = RELAY_FANOUT): void {
    node.addr = addr;
    node.fanout = fanout;
}

/**
 * ノード消失時: そのノードの subtree 全員を孤児として取り除き、
 * 「失われた 子スロット」の解放と「孤児の再割り当て」を呼び出し元に返す。
 * (§3.4: subtree単位で一括処理し、個別再割り当てによる二重掴みを防ぐ)
 *
 * 戻り値: { orphans: 取り除かれたノード配列 (root自身が消えた場合は除く),
 *          rootLost: 根が消えたか (木全体消滅) }
 * 注意: 根は「ホスト」なので消失=ルーム終了。rootLost=true は再割り当て不可。
 */
export function detachSubtree(root: TreeNode, lostId: string): TreeNode[] {
    const lost = findNode(root, lostId);
    if (!lost || lost === root) return [];
    // 孤児 = 消えたノード自身を除く subtree のメンバー (死んだノードは再割り当て不可)
    const orphans = flatten(lost).filter(n => n.id !== lostId);
    // 親から切り離す
    const detach = (node: TreeNode): boolean => {
        const idx = node.children.findIndex(c => c.id === lostId);
        if (idx >= 0) {
            node.children.splice(idx, 1);
            return true;
        }
        return node.children.some(detach);
    };
    detach(root);
    return orphans;
}

/**
 * 孤児たちを現在の木の空きスロットへ幅優先で再割り当てする (§3.4-2)。
 * 戻り値: orphanId -> 親ノード (addr取得用)。入りきらない孤児は unspecified。
 */
export function reassignOrphans(
    root: TreeNode,
    orphanIds: string[],
    maxDepth = MAX_DEPTH,
): Map<string, TreeNode> {
    const out = new Map<string, TreeNode>();
    for (const id of orphanIds) {
        const parent = pickParent(root, maxDepth);
        if (!parent) continue; // 満杯 — 呼び出し側は待機/再試行
        const node: TreeNode = { id, addr: null, depth: parent.depth + 1, fanout: 0, children: [] };
        parent.children.push(node);
        out.set(id, parent);
    }
    return out;
}

/** 木の不変条件チェック (テスト/E2E用): fan-outと深さの上限内に収まっているか */
export function validateInvariants(
    root: TreeNode,
    maxDepth = MAX_DEPTH,
): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    const walk = (node: TreeNode): void => {
        if (node.children.length > node.fanout) {
            violations.push(`fan-out超過: ${node.id} (${node.children.length}/${node.fanout})`);
        }
        if (node.depth > maxDepth) {
            violations.push(`深さ超過: ${node.id} (depth=${node.depth})`);
        }
        node.children.forEach(walk);
    };
    walk(root);
    return { ok: violations.length === 0, violations };
}
