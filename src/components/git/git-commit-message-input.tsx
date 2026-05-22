import { Loader2, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/hooks/use-locale';
import { cn } from '@/lib/utils';

interface GitCommitMessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onGenerateAI: () => Promise<void>;
  isGenerating?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

// Minimum and maximum height for the textarea (in lines)
const MIN_LINES = 1;
const MAX_LINES = 5;

export function GitCommitMessageInput({
  value,
  onChange,
  onGenerateAI,
  isGenerating = false,
  placeholder,
  disabled = false,
}: GitCommitMessageInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useTranslation();

  // Auto-resize textarea height based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to calculate actual scroll height
      textarea.style.height = 'auto';
      // Calculate line height (approximately 20px per line for text-sm)
      const lineHeight = 20;
      const minHeight = lineHeight * MIN_LINES;
      const maxHeight = lineHeight * MAX_LINES;
      // Set height based on scroll height, within min/max bounds
      const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${newHeight}px`;
    }
  });

  // Count lines in the message
  const lineCount = value.split('\n').length;

  // Placeholder with default
  const actualPlaceholder = placeholder ?? t.Git.commitPlaceholder;

  return (
    <div className="relative w-full">
      {/* Message textarea - auto-expanding */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={actualPlaceholder}
        disabled={disabled || isGenerating}
        className={cn(
          'w-full text-sm pr-9 px-3 py-1.5 rounded-md border border-input bg-transparent',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'resize-none overflow-hidden',
          isFocused && 'ring-2 ring-primary'
        )}
        style={{ height: '20px' }}
      />

      {/* AI Generate button - inside textarea on the right */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
            onClick={onGenerateAI}
            disabled={disabled || isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            ) : (
              <Wand2 className="h-3.5 w-3.5 text-purple-500" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {isGenerating ? t.Git.tooltips.generatingMessage : t.Git.tooltips.generateMessage}
        </TooltipContent>
      </Tooltip>

      {/* Line count indicator */}
      {value.length > 0 && (
        <div className="absolute right-10 bottom-1 text-xs text-muted-foreground">{lineCount}</div>
      )}
    </div>
  );
}
