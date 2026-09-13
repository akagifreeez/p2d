/**
 * P2D Cloudflare Workers シグナリング — 部屋コア (純粋ロジック)
 *
 * Durable Object (1ルーム=1インスタンス) から使う、WebSocketに依存しない
 * 部屋状態とメッセージ処理。Node signaling-server と同一プロトコル:
 *   room:create / room:join / room:leave / peer:offer|answer|ice /
 *   peer:tunnel / relay:* (同一ルーム所属検証付き転送)
 *
 * DOモデルの意味論 (Nodeサーバーとの差分):
 *   - ルームはDO自身 (URLの ?room=コード で特定)。空でも存在し続ける
 *   - 先にホストがcreateしなくても最初のjoinで部屋として機能する
 *
 * テスト: node --import tsx --test (WebSocket不要で検証できる)
 */

export interface Participant {
    id: string;
    name?: string;
    joinedAt: number;
}

export interface Member {
    name?: string;
    joinedAt: number;
}

export interface OutMessage {
    /** 宛先クライアントID。null = メンバー全員へのブロードキャスト */
    to: string | null;
    data: unknown;
}

export interface RoomCoreState {
    code: string;
    hostEndpoint?: string;
    maxParticipants: number;
    /** 現在部屋にいるメンバー (接続が切れたら除去) */
    members: Map<string, Member>;
    /** 接続中の全クライアント (未参加の接続も含む) */
    connections: Set<string>;
    now(): number;
}

export function createRoomCore(code: string, maxParticipants = 8): RoomCoreState {
    return {
        code: code.toUpperCase(),
        maxParticipants,
        members: new Map(),
        connections: new Set(),
        now: () => Date.now(),
    };
}

interface SourcedMessage {
    type: string;
    senderId?: string;
    targetId?: string;
    timestamp?: number;
    payload?: Record<string, unknown>;
}

function s2c(to: string, data: unknown): OutMessage {
    return { to, data };
}

function broadcastMembers(state: RoomCoreState, data: unknown): OutMessage[] {
    const out: OutMessage[] = [];
    for (const id of state.members.keys()) {
        out.push(s2c(id, data));
    }
    return out;
}

function participantList(state: RoomCoreState, exceptId: string): Participant[] {
    const list: Participant[] = [];
    for (const [id, m] of state.members) {
        if (id !== exceptId) list.push({ id, name: m.name, joinedAt: m.joinedAt });
    }
    return list;
}

/** 接続時: 接続確認 (ダミーroom:joined, myId付与) */
export function coreAck(state: RoomCoreState, myId: string): OutMessage {
    state.connections.add(myId);
    return s2c(myId, {
        type: 'room:joined',
        timestamp: state.now(),
        payload: { roomId: '', roomCode: '', myId, participants: [] },
    });
}

/** 切断時: 退室処理 + 残存メンバーへの peer:left */
export function coreDisconnect(state: RoomCoreState, myId: string): OutMessage[] {
    if (!state.connections.has(myId)) return [];
    state.connections.delete(myId);
    if (!state.members.has(myId)) return [];
    state.members.delete(myId);
    return broadcastMembers(state, {
        type: 'peer:left',
        senderId: myId,
        timestamp: state.now(),
        payload: { peerId: myId },
    });
}

/**
 * メッセージ処理 (中央サーバーのindex.tsと同一意味論のサブセット)。
 * 戻り値: 送信すべきメッセージ群
 */
export function coreMessage(
    state: RoomCoreState,
    myId: string,
    msg: SourcedMessage,
): OutMessage[] {
    const type = String(msg.type ?? '');
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const ts = state.now();

    if (type === 'room:create' || type === 'room:join') {
        return handleCreateJoin(state, myId, type === 'room:create', payload, ts);
    }

    if (type === 'room:leave') {
        if (!state.members.has(myId)) return [];
        state.members.delete(myId);
        return broadcastMembers(state, {
            type: 'peer:left',
            senderId: myId,
            timestamp: ts,
            payload: { peerId: myId },
        });
    }

    const forwardable = type.startsWith('relay:')
        || type === 'peer:offer' || type === 'peer:answer'
        || type === 'peer:ice' || type === 'peer:tunnel';
    if (forwardable) {
        const target = String(msg.targetId ?? '');
        if (!target || target === myId) return [];
        // 同一ルーム所属検証 (中央サーバー/内蔵サーバーと同等)
        if (!state.members.has(myId) || !state.members.has(target)) {
            return [s2c(myId, {
                type: 'error',
                timestamp: ts,
                payload: { code: 'PARTICIPANT_UNKNOWN', message: '参加者が見つかりません' },
            })];
        }
        const fwd: SourcedMessage = { ...msg, senderId: myId, timestamp: ts };
        return [s2c(target, fwd)];
    }

    return [s2c(myId, {
        type: 'error',
        timestamp: ts,
        payload: { code: 'UNKNOWN_TYPE', message: `不明なメッセージタイプ: ${type}` },
    })];
}

/**
 * 部屋への参加。DOモデルでは部屋は常に存在するため:
 * - room:create: 常に成功 (member登録。既存なら冪等)。hostEndpointを更新
 * - room:join: 満員なら ROOM_FULL、それ以外は登録
 * - room:joinがルーム未作成で失敗する、というNodeサーバーとの差分はない
 *   (URLの ?room= が部屋の実体。phone bookはhostEndpoint配布のみに使用)
 */
function handleCreateJoin(
    state: RoomCoreState,
    myId: string,
    isCreate: boolean,
    payload: Record<string, unknown>,
    ts: number,
): OutMessage[] {
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    const hostEndpoint = typeof payload.hostEndpoint === 'string' ? payload.hostEndpoint : undefined;

    const alreadyMember = state.members.has(myId);
    if (!alreadyMember && state.members.size >= state.maxParticipants) {
        return [s2c(myId, {
            type: 'error',
            timestamp: ts,
            payload: { code: 'ROOM_FULL', message: 'ルームが満員です' },
        })];
    }

    if (!alreadyMember) {
        state.members.set(myId, { name, joinedAt: ts });
    }
    if (hostEndpoint) {
        state.hostEndpoint = hostEndpoint;
    }

    const responses: OutMessage[] = [];
    if (isCreate) {
        responses.push(s2c(myId, {
            type: 'room:created',
            senderId: myId,
            timestamp: ts,
            payload: { roomCode: state.code, roomId: state.code, hostEndpoint: state.hostEndpoint },
        }));
    }
    responses.push(s2c(myId, {
        type: 'room:joined',
        senderId: myId,
        timestamp: ts,
        payload: {
            roomId: state.code,
            roomCode: state.code,
            myId,
            participants: participantList(state, myId),
            hostEndpoint: state.hostEndpoint,
        },
    }));

    // 新規メンバーだった場合のみ、既存メンバーへ peer:joined
    if (!alreadyMember) {
        for (const [id] of state.members) {
            if (id === myId) continue;
            responses.push(s2c(id, {
                type: 'peer:joined',
                senderId: myId,
                timestamp: ts,
                payload: { peerId: myId, name },
            }));
        }
    }
    return responses;
}
