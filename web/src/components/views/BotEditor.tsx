import { Brain, Puzzle, Save, Shield, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Bot, McpServerEntry } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, toast, useStore } from '../../store';
import { cx } from '../../utils';
import { Avatar, confirmDialog, Modal } from '../ui';
import { deleteBotFlow } from './BotsView';
import { BasicTab } from './bot-editor/BasicTab';
import { BOT_NAME_RE } from './bot-editor/identity';
import { MemoryTab } from './bot-editor/MemoryTab';
import { PermTab } from './bot-editor/PermTab';
import { PluginsTab } from './bot-editor/PluginsTab';

type Tab = 'basic' | 'perm' | 'plugins' | 'memory';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'basic', label: '基本', icon: UserRound },
  { id: 'perm', label: '权限', icon: Shield },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'memory', label: '记忆', icon: Brain },
];

export function BotEditorDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const bot = useStore((s) => s.bots[botId]);
  const [draft, setDraft] = useState<Bot | null>(() => (bot ? structuredClone(bot) : null));
  const [tab, setTab] = useState<Tab>('basic');
  const [saving, setSaving] = useState(false);
  const [mcpText, setMcpText] = useState(() => (bot && Object.keys(bot.mcpServers || {}).length ? JSON.stringify(bot.mcpServers, null, 2) : ''));
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryOrig, setMemoryOrig] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);

  // Deleted elsewhere: close.
  useEffect(() => {
    if (!bot) onClose();
  }, [bot, onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .memory(botId)
      .then((r) => {
        if (cancelled) return;
        setMemory(r.text);
        setMemoryOrig(r.text);
      })
      .catch((e) => {
        if (cancelled) return;
        setMemory('');
        toast('加载记忆失败', (e as Error).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (!bot || !draft) return null;

  const patch = (p: Partial<Bot>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const nameOk = BOT_NAME_RE.test(draft.name.trim());
  const memoryDirty = memory !== null && memory !== memoryOrig;

  const saveMemory = async () => {
    if (memory === null) return;
    setMemoryBusy(true);
    try {
      await api.saveMemory(botId, memory);
      setMemoryOrig(memory);
      toast('记忆已保存', undefined, 'success');
    } catch (e) {
      toast('保存记忆失败', (e as Error).message, 'error');
    } finally {
      setMemoryBusy(false);
    }
  };

  const save = async () => {
    if (!nameOk) {
      setTab('basic');
      toast('名字不合法', '只能包含字母、数字、中文、下划线或连字符（最多 24 个字符），不能有空格', 'error');
      return;
    }
    let mcpServers: Record<string, McpServerEntry> = {};
    if (mcpText.trim()) {
      try {
        const v = JSON.parse(mcpText);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('需要是一个对象：{ "名字": { … } }');
        mcpServers = v;
      } catch (e) {
        setTab('plugins');
        toast('自定义 MCP 服务器配置有误', (e as Error).message, 'error');
        return;
      }
    }
    if (draft.projectId !== bot.projectId && dmOf(botId)?.workspaceId) {
      const ok = await confirmDialog({
        title: '切换项目？',
        body: `和 ${bot.name} 的单聊正在独立工作区里工作，切换项目会关闭这个工作区。还没合并的改动会保留在它的分支里。`,
        ok: '切换',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await api.updateBot(botId, {
        name: draft.name.trim(),
        emoji: draft.emoji.trim() || '🤖',
        color: draft.color,
        title: draft.title,
        description: draft.description,
        model: draft.model.trim(),
        effort: draft.effort,
        permission: draft.permission,
        allowRules: draft.allowRules,
        askRules: draft.askRules,
        plugins: draft.plugins,
        loadUserSettings: draft.loadUserSettings,
        projectId: draft.projectId,
        mcpServers,
      });
      if (memoryDirty && memory !== null) await api.saveMemory(botId, memory);
      toast(`已保存 ${draft.name.trim()} 的设置`, undefined, 'success');
      onClose();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (await deleteBotFlow(bot)) onClose();
  };

  return (
    <Modal
      title={`${bot.name} 的设置`}
      icon={<Avatar bot={draft} size={32} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger foot-left" onClick={remove}>
            <Trash2 size={15} /> 删除机器人
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? <span className="spinner" /> : <Save size={15} />} 保存
          </button>
        </>
      }
    >
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
            <t.icon size={15} /> {t.label}
            {t.id === 'memory' && memoryDirty && <span className="tab-dot" />}
          </button>
        ))}
      </div>

      {tab === 'basic' && <BasicTab draft={draft} patch={patch} nameOk={nameOk} />}

      {tab === 'perm' && <PermTab draft={draft} patch={patch} />}

      {tab === 'plugins' && <PluginsTab draft={draft} patch={patch} mcpText={mcpText} setMcpText={setMcpText} />}

      {tab === 'memory' && <MemoryTab memory={memory} setMemory={setMemory} dirty={memoryDirty} busy={memoryBusy} onSave={saveMemory} />}
    </Modal>
  );
}
