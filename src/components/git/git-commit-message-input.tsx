import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface GitCommitMessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onGenerateAI: () => Promise<void>;
  isGenerating?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export function GitCommitMessageInput({
  value,
  onChange,
  onGenerateAI,
  isGenerating = false,
  placeholder = 'Enter commit message...',
  disabled = false,
}: GitCommitMessageInputProps) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {/* Message input */}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder={placeholder}
        disabled={disabled || isGenerating}
        className={cn('min-h-[80px] resize-none text-sm', isFocused && 'ring-2 ring-primary')}
        maxLength={500}
      />

      {/* Character count and AI button */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{value.length}/500</span>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5"
          onClick={onGenerateAI}
          disabled={disabled || isGenerating}
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span className="text-xs">AI Generate</span>
        </Button>
      </div>
    </div>
  );
}
