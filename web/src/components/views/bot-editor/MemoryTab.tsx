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
        <label>Long-term memory (the bot writes it with the remember tool and sees it in every chat)</label>
        {memory === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : (
          <textarea
            className="textarea mono tall"
            value={memory}
            spellCheck={false}
            placeholder={'No memory yet. You can note project conventions, your preferences and so on, e.g.:\n- The user likes a clean UI, primary color #0a84ff\n- Write commit messages in English'}
            onChange={(e) => setMemory(e.target.value)}
          />
        )}
      </div>
      <div className="row">
        <span className="hint">Long memory takes up context, so tidy it up now and then.</span>
        <span className="spacer" />
        <button className="btn" disabled={!memoryDirty || memoryBusy} onClick={saveMemory}>
          {memoryBusy ? <span className="spinner" /> : <Save size={14} />} Save memory
        </button>
      </div>
    </div>
  );
}
