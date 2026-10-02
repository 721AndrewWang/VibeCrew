import { Info } from 'lucide-react';
import { useStore } from '../../../store';
import { Logo } from '../../ui';
import { Section } from './Section';

export function AboutSection() {
  const version = useStore((s) => s.version);
  return (
    <Section icon={<Info size={18} />} title="关于">
      <div className="about">
        <Logo size={40} />
        <div>
          <div className="sr-title">Crew {version}</div>
          <div className="hint">灵感来自 xAI Grokbot，基于 Claude Code / Claude Agent SDK</div>
        </div>
      </div>
    </Section>
  );
}
