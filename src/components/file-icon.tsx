/**
 * File Icon Component
 * Renders appropriate icon based on file extension
 */

import { cn } from '@/lib/utils';
import { getFileIcon } from './file-icons';

export interface FileIconProps {
  filename: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

/**
 * FileIcon component displays an icon based on the file extension
 * Similar to VSCode's file icon theme
 */
export function FileIcon({ filename, className, size = 'sm' }: FileIconProps) {
  const { icon: Icon, color } = getFileIcon(filename);

  return (
    <Icon
      className={cn(SIZE_CLASSES[size], 'flex-shrink-0', color, className)}
      aria-hidden="true"
    />
  );
}
