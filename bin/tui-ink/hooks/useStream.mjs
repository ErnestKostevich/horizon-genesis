// bin/tui-ink/hooks/useStream.mjs
//
// Hook for incremental token streaming. Returns:
//   { text, append, reset, isStreaming }
//
// The production port wires append() to the runtime.runChatStream
// onToken callback. The skeleton uses it for the /demo-stream command
// in App.mjs (currently inlined for clarity but kept here as the
// future home).

import { useState, useCallback, useRef } from 'react';

export default function useStream() {
  const [text, setText] = useState('');
  const [isStreaming, setStreaming] = useState(false);
  const bufferRef = useRef('');

  const append = useCallback((chunk) => {
    bufferRef.current += String(chunk || '');
    setText(bufferRef.current);
    setStreaming(true);
  }, []);

  const done = useCallback(() => {
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    bufferRef.current = '';
    setText('');
    setStreaming(false);
  }, []);

  return { text, append, done, reset, isStreaming };
}
