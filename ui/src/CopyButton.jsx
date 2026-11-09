import React, {useEffect, useId, useRef, useState} from 'react';
import {Check, Copy} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {writeClipboardText} from './lib/clipboard.mjs';
import './copy-button.css';

const failureMessage = 'Не удалось скопировать автоматически. Скопируйте выделенный текст: нажмите ⌘C или Ctrl+C либо выберите «Копировать» в меню устройства.';

function CopyControl({text, label, successLabel}) {
  const [status, setStatus] = useState('idle');
  const manual = useRef(null);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const active = useRef(false);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current++; };
  }, []);
  useEffect(() => {
    if (status === 'failed') {
      manual.current?.focus();
      manual.current?.select();
    }
  }, [status]);

  async function copy() {
    if (active.current) return;
    active.current = true;
    const request = ++attempt.current;
    const isCurrent = () => mounted.current && attempt.current === request;
    setStatus('pending');
    const copied = await writeClipboardText(text, isCurrent);
    if (!isCurrent()) return;
    active.current = false;
    setStatus(copied ? 'copied' : 'failed');
  }

  const failed = status === 'failed';
  const copied = status === 'copied';
  return <div className="copy-control">
    <Button type="button" variant="ghost" leadingIcon={copied ? Check : Copy}
      onClick={copy} aria-busy={status === 'pending' || undefined}
      aria-disabled={status === 'pending' || undefined}
      aria-describedby={failed ? id + '-feedback' : undefined}>
      {copied ? successLabel : status === 'pending' ? 'Копируем…' : label}
    </Button>
    <p id={id + '-feedback'} role="status" aria-live="polite" aria-atomic="true"
      className={failed ? 'copy-feedback' : 'copy-feedback copy-status-only'}>
      {failed ? failureMessage : copied ? successLabel : status === 'pending' ? 'Копируем…' : ''}
    </p>
    {failed && <div className="copy-manual">
      <label htmlFor={id + '-manual'}>Текст для ручного копирования — {label}</label>
      <textarea id={id + '-manual'} ref={manual} value={text} readOnly rows={6}
        spellCheck={false} aria-describedby={id + '-feedback'}/>
    </div>}
  </div>;
}

// Remounting also invalidates pending feedback when the payload changes.
export default function CopyButton({text, label = 'Копировать текст', successLabel = 'Текст скопирован'}) {
  return <CopyControl key={text} text={text} label={label} successLabel={successLabel}/>;
}
