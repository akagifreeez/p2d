/**
 * P2D - DataChannel管理フック
 * 
 * RTCPeerConnectionからDataChannelを作成し、チャット機能を提供する。
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { DataChannelManager, ChatMessageData, ChatMessage } from '../lib/dataChannel';

export interface UseDataChannelOptions {
    peerConnection: RTCPeerConnection | null;
    isHost: boolean;
}

export interface UseDataChannelReturn {
    // チャット
    messages: ChatMessageData[];
    sendMessage: (text: string) => boolean;

    // 状態
    isDataChannelOpen: boolean;
}

export function useDataChannel({
    peerConnection,
    isHost
}: UseDataChannelOptions): UseDataChannelReturn {
    const managerRef = useRef<DataChannelManager | null>(null);
    const [messages, setMessages] = useState<ChatMessageData[]>([]);
    const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);

    // DataChannelManagerのセットアップ
    useEffect(() => {
        if (!peerConnection) {
            setIsDataChannelOpen(false);
            return;
        }

        const manager = new DataChannelManager(isHost, {
            onOpen: () => {
                console.log('[useDataChannel] チャンネル開始');
                setIsDataChannelOpen(true);
            },
            onClose: () => {
                console.log('[useDataChannel] チャンネル終了');
                setIsDataChannelOpen(false);
            },
            onChatMessage: (message: ChatMessage) => {
                setMessages((prev) => [...prev, message.data]);
            },
        });

        managerRef.current = manager;

        if (isHost) {
            // ホスト側: DataChannelを作成
            manager.createChannel(peerConnection);
        } else {
            // ビューア側: DataChannelの受信を待機
            manager.setupOnDataChannel(peerConnection);
        }

        return () => {
            manager.close();
            managerRef.current = null;
        };
    }, [peerConnection, isHost]);

    // メッセージ送信
    const sendMessage = useCallback((text: string): boolean => {
        if (!managerRef.current) return false;

        const success = managerRef.current.sendChatMessage(text);

        if (success) {
            // 自分のメッセージもリストに追加
            const myMessage: ChatMessageData = {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                sender: isHost ? 'host' : 'viewer',
                text,
            };
            setMessages((prev) => [...prev, myMessage]);
        }

        return success;
    }, [isHost]);

    return {
        messages,
        sendMessage,
        isDataChannelOpen,
    };
}
