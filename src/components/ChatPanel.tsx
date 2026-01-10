/**
 * P2D - チャットパネルコンポーネント
 * 
 * DataChannelを使用したリアルタイムチャット機能。
 */

import { useState, useRef, useEffect } from 'react';
import type { ChatMessageData } from '../lib/dataChannel';

interface ChatPanelProps {
    messages: ChatMessageData[];
    onSendMessage: (text: string) => void;
    isConnected: boolean;
    isHost: boolean;
    className?: string;
}

export function ChatPanel({
    messages,
    onSendMessage,
    isConnected,
    isHost,
    className = ''
}: ChatPanelProps) {
    const [inputText, setInputText] = useState('');
    const [isExpanded, setIsExpanded] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // 新しいメッセージが来たらスクロール
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputText.trim() && isConnected) {
            onSendMessage(inputText.trim());
            setInputText('');
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e as unknown as React.FormEvent);
        }
    };

    return (
        <div className={`card overflow-hidden ${className}`}>
            {/* ヘッダー */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-4 flex items-center justify-between hover:bg-dark-700/50 transition-colors"
            >
                <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <span className="font-medium">チャット</span>
                    {messages.length > 0 && (
                        <span className="px-2 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded-full">
                            {messages.length}
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
                    <svg
                        className={`w-4 h-4 text-dark-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </button>

            {/* チャット本体 */}
            {isExpanded && (
                <div className="border-t border-dark-700">
                    {/* メッセージ一覧 */}
                    <div className="h-48 overflow-y-auto p-4 space-y-3">
                        {messages.length === 0 ? (
                            <p className="text-dark-500 text-sm text-center py-4">
                                メッセージはまだありません
                            </p>
                        ) : (
                            messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`flex ${msg.sender === (isHost ? 'host' : 'viewer') ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[80%] px-3 py-2 rounded-lg ${msg.sender === (isHost ? 'host' : 'viewer')
                                                ? 'bg-primary-500/20 text-primary-100'
                                                : 'bg-dark-700 text-dark-200'
                                            }`}
                                    >
                                        {msg.senderName && (
                                            <div className="text-xs text-dark-400 mb-1">
                                                {msg.senderName}
                                            </div>
                                        )}
                                        <p className="text-sm break-words">{msg.text}</p>
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* 入力フォーム */}
                    <form onSubmit={handleSubmit} className="p-3 border-t border-dark-700">
                        <div className="flex space-x-2">
                            <input
                                type="text"
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={isConnected ? 'メッセージを入力...' : '接続待機中...'}
                                disabled={!isConnected}
                                className="flex-1 px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm placeholder-dark-500 focus:outline-none focus:border-primary-500 disabled:opacity-50"
                            />
                            <button
                                type="submit"
                                disabled={!isConnected || !inputText.trim()}
                                className="px-4 py-2 bg-primary-500 text-white rounded-lg text-sm font-medium hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                送信
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
