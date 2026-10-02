import { Save } from 'lucide-react';

export function MemoryTab({
  memory,
  setMemory,
  dirty: memoryDirty,
  busy: memoryBusy,
  onSave: saveMemory,
}: {
  memory: string | null;
  setMemory: (v: string) => void;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <div className="tab-body">
      <div className="field">
        <label>长期记忆（机器人通过 remember 工具写入，每次对话都能看到）</label>
        {memory === null ? (
          <div className="row muted">
            <span className="spinner" /> 正在加载…
          </div>
        ) : (
          <textarea
            className="textarea mono tall"
            value={memory}
            spellCheck={false}
            placeholder={'还没有记忆。可以写下项目约定、你的偏好等，例如：\n- 用户喜欢简洁的界面，主色 #0a84ff\n- 提交信息用中文'}
            onChange={(e) => setMemory(e.target.value)}
          />
        )}
      </div>
      <div className="row">
        <span className="hint">记忆太长会占用上下文，可以定期整理。</span>
        <span className="spacer" />
        <button className="btn" disabled={!memoryDirty || memoryBusy} onClick={saveMemory}>
          {memoryBusy ? <span className="spinner" /> : <Save size={14} />} 保存记忆
        </button>
      </div>
    </div>
  );
}
