/**
 * P2D - Chat Panel (Full Mesh P2P Update)
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
        <div className={`glass-card overflow-hidden transition-all duration-300 ${className} ${isExpanded ? 'bg-black/40' : 'bg-white/5'}`}>
            {/* Header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-3 flex items-center justify-between hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center space-x-2">
                    <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <span className="font-bold text-sm tracking-wide text-gray-200">TEXT CHAT</span>
                    {messages.length > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500/20 text-cyan-400 rounded border border-cyan-500/30">
                            {messages.length}
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500 shadow-[0_0_5px_#22c55e]' : 'bg-gray-600'}`}></div>
                    <svg
                        className={`w-3 h-3 text-gray-400 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
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
                <div className="border-t border-white/10 animate-fade-in">
                    {/* Message List */}
                    <div className="h-48 overflow-y-auto p-3 space-y-3 custom-scrollbar bg-black/20">
                        {messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-gray-600 space-y-2">
                                <svg className="w-8 h-8 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                                <p className="text-xs">No messages yet</p>
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
                                            className={`max-w-[85%] px-3 py-2 rounded-lg text-sm border ${isMe
                                                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-100 rounded-tr-none'
                                                : 'bg-white/5 border-white/10 text-gray-200 rounded-tl-none'
                                                }`}
                                        >
                                            <p className="break-words leading-relaxed">{msg.content}</p>
                                            <div className={`text-[9px] mt-1 text-right gap-2 flex justify-end ${isMe ? 'text-cyan-500/60' : 'text-gray-500'}`}>
                                                {!isMe && <span className="opacity-75">{msg.senderName}</span>}
                                                <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <form onSubmit={handleSubmit} className="p-3 bg-white/5 border-t border-white/10">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={isConnected ? 'Type a message...' : 'Connecting...'}
                                disabled={!isConnected}
                                className="flex-1 px-3 py-2 bg-black/50 border border-white/10 rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                            />
                            <button
                                type="submit"
                                disabled={!isConnected || !inputText.trim()}
                                className="px-3 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
