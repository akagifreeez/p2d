/**
 * P2D - Chat Panel (Full Mesh P2P Update)
 *
 * レイアウト: 縦フレックスで入力欄をパネル最下部に固定し、
 * メッセージは少ないときも下端に寄って追尾する (justify-end + 自動スクロール)。
 */

import { useState, useRef, useEffect } from 'react';
import type { ChatMessageData } from '../lib/dataChannel';

interface ChatPanelProps {
    messages: ChatMessageData[];
    onSendMessage: (text: string) => void;
    isConnected: boolean;
    myId: string | null;
    className?: string;
}

export function ChatPanel({
    messages,
    onSendMessage,
    isConnected,
    myId,
    className = ''
}: ChatPanelProps) {
    const [inputText, setInputText] = useState('');
    const [isExpanded, setIsExpanded] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

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
        <div className={`flex flex-col overflow-hidden transition-colors duration-200 ${className} ${isExpanded ? 'bg-[var(--md-surface-low)]' : 'bg-[var(--md-surface-container)]'}`}>
            {/* Header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-3 shrink-0 flex items-center justify-between hover:bg-[color-mix(in_srgb,var(--md-on-surface)_6%,transparent)] transition-colors"
            >
                <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-[var(--md-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <span className="text-[13px] font-medium text-[var(--md-on-surface)]">チャット</span>
                    {messages.length > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded-md bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]">
                            {messages.length}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[var(--md-primary)]' : 'bg-[var(--md-outline)]'}`}></span>
                    <svg
                        className={`w-3.5 h-3.5 text-[var(--md-on-surface-variant)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </button>

            {/* Chat Body */}
            {isExpanded && (
                <div className="flex-1 flex flex-col min-h-0 border-t border-[var(--md-outline-variant)]/60">
                    {/* Message List — 下端に寄せて追尾 */}
                    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col justify-end gap-2">
                        {messages.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-[var(--md-on-surface-variant)] gap-2">
                                <svg className="w-7 h-7 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                                <p className="text-xs">まだメッセージはありません</p>
                            </div>
                        ) : (
                            messages.map((msg) => {
                                const isMe = msg.senderId === myId;
                                return (
                                    <div
                                        key={msg.id}
                                        className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}
                                    >
                                        <div
                                            className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm ${isMe
                                                ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] rounded-br-md'
                                                : 'bg-[var(--md-surface-high)] text-[var(--md-on-surface)] rounded-bl-md'
                                                }`}
                                        >
                                            <p className="break-words leading-relaxed">{msg.content}</p>
                                            <div className={`text-[10px] mt-1 flex justify-end gap-2 ${isMe ? 'opacity-70' : 'text-[var(--md-on-surface-variant)]'}`}>
                                                {!isMe && <span>{msg.senderName}</span>}
                                                <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area — 常に最下部 */}
                    <form onSubmit={handleSubmit} className="p-3 shrink-0 border-t border-[var(--md-outline-variant)]/60">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={isConnected ? 'メッセージを入力…' : '接続中…'}
                                disabled={!isConnected}
                                className="input flex-1 !h-10 text-sm"
                            />
                            <button
                                type="submit"
                                disabled={!isConnected || !inputText.trim()}
                                className="md-icon-btn md-icon-btn-active !h-10 !w-10 disabled:opacity-40"
                                title="送信"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
