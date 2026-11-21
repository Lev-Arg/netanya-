import React, { useEffect, useState } from 'react';
import { MessageSquare, Plus, Send } from 'lucide-react';
import type { AuthUser, ConsultationMessage, ConsultationThread } from '../types.ts';
import { apiFetch, useRealtimeTopics } from '../utils/api.ts';

interface ConsultationChatProps {
  user: AuthUser;
  token: string;
}

export const ConsultationChat: React.FC<ConsultationChatProps> = ({ user, token }) => {
  const [threads, setThreads] = useState<ConsultationThread[]>([]);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, ConsultationMessage[]>>({});
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [newInitialBody, setNewInitialBody] = useState('');
  const [showNewThread, setShowNewThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConsultations = async () => {
    try {
      const res = await apiFetch<{
        threads: ConsultationThread[];
        messagesByThread: Record<string, ConsultationMessage[]>;
      }>('/api/consultations');
      setThreads(res.threads);
      setMessagesByThread(res.messagesByThread);
      if (!selectedThreadId && res.threads.length > 0) {
        setSelectedThreadId(res.threads[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load consultations.');
    }
  };

  useEffect(() => {
    loadConsultations();
  }, []);

  useRealtimeTopics(['consultations'], loadConsultations, token);

  const activeThread = threads.find((t) => t.id === selectedThreadId) || threads[0] || null;
  const activeMessages = activeThread ? messagesByThread[activeThread.id] || [] : [];

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeThread || !replyText.trim()) return;
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/api/consultations/${activeThread.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: replyText.trim() }),
      });
      setReplyText('');
      await loadConsultations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  const handleCreateThread = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubject.trim() || !newInitialBody.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch<{ threadId: string }>('/api/consultations', {
        method: 'POST',
        body: JSON.stringify({
          subject: newSubject.trim(),
          initialMessage: newInitialBody.trim(),
        }),
      });
      setNewSubject('');
      setNewInitialBody('');
      setShowNewThread(false);
      await loadConsultations();
      setSelectedThreadId(res.threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start consultation.');
    } finally {
      setSending(false);
    }
  };

  const handleToggleThreadStatus = async () => {
    if (!activeThread) return;
    const nextStatus = activeThread.status === 'open' ? 'resolved' : 'open';
    await apiFetch(`/api/consultations/${activeThread.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadConsultations();
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Thread List */}
      <div className="rounded-xl border border-slate-200 bg-white lg:col-span-4">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
          <h3 className="font-display text-sm font-bold text-slate-900">
            {user.role === 'patient' ? 'Pharmacist Chat' : 'Messages'}
          </h3>
          {user.role === 'patient' && (
            <button
              type="button"
              onClick={() => setShowNewThread((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Ask
            </button>
          )}
        </div>

        {showNewThread && user.role === 'patient' && (
          <form onSubmit={handleCreateThread} className="border-b border-slate-200 bg-orange-50/40 p-4 space-y-2.5">
            <input
              type="text"
              required
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="Topic (e.g., Side effect or timing question)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
            />
            <textarea
              required
              rows={3}
              value={newInitialBody}
              onChange={(e) => setNewInitialBody(e.target.value)}
              placeholder="Describe your medication question..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-orange-500 focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewThread(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending}
                className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
              >
                Start Consult
              </button>
            </div>
          </form>
        )}

        <div className="divide-y divide-slate-100">
          {threads.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              No active consultation threads yet.
            </div>
          ) : (
            threads.map((t) => {
              const selected = activeThread?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedThreadId(t.id)}
                  className={`w-full px-4 py-3.5 text-left transition-colors ${
                    selected ? 'bg-orange-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900 truncate">
                      {user.role === 'patient' ? t.subject : t.patientName}
                    </span>
                    {t.unreadCount > 0 && (
                      <span className="font-mono text-[11px] font-bold text-orange-600 tabular-nums">
                        {t.unreadCount} new
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-600 truncate">
                    {user.role === 'patient' ? 'Pharmacist' : t.subject}
                    <span className="ml-1.5 text-[11px] text-slate-400">· {t.status}</span>
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                    {new Date(t.lastMessageAt).toLocaleString()}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Active Conversation */}
      <div className="flex h-[500px] flex-col rounded-xl border border-slate-200 bg-white lg:col-span-8">
        {activeThread ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
              <div>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  {activeThread.subject}
                </h3>
                <p className="text-xs text-slate-500">
                  {activeThread.patientName} ·{' '}
                  <strong className={activeThread.status === 'resolved' ? 'text-emerald-700' : 'text-orange-600'}>
                    {activeThread.status.toUpperCase()}
                  </strong>
                </p>
              </div>
              <button
                type="button"
                onClick={handleToggleThreadStatus}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-orange-500 shrink-0"
              >
                {activeThread.status === 'open' ? 'Mark Resolved' : 'Reopen'}
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {activeMessages.map((msg) => {
                const isMine = msg.senderId === user.id;
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                      <span className="font-semibold text-slate-700">{msg.senderName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{msg.senderRole}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(msg.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div
                      className={`max-w-[82%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                        isMine
                          ? 'bg-orange-600 text-white'
                          : 'border border-slate-200 bg-slate-50 text-slate-900'
                      }`}
                    >
                      {msg.body}
                    </div>
                  </div>
                );
              })}
            </div>

            <form
              onSubmit={handleSendMessage}
              className="flex items-center gap-2 border-t border-slate-200 p-3.5"
            >
              <input
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={
                  user.role === 'patient'
                    ? 'Ask about dosage, side effects, or refills...'
                    : 'Write a reply...'
                }
                className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-orange-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !replyText.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50 min-h-[42px]"
              >
                <Send className="h-3.5 w-3.5" />
                Send
              </button>
            </form>
            {error && (
              <p className="px-4 pb-3 text-xs font-medium text-red-600">{error}</p>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <MessageSquare className="h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-800">Select a consultation thread</p>
          </div>
        )}
      </div>
    </div>
  );
};
