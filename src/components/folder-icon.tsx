/**
 * Folder Icon Component
 * Renders appropriate icon based on folder name
 */

import { cn } from '@/lib/utils';
import { getFolderIcon } from './file-icons';

export interface FolderIconProps {
  folderName: string;
  isOpen?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

/**
 * FolderIcon component displays an icon based on the folder name
 * Similar to VSCode's folder icon theme
 */
export function FolderIcon({
  folderName,
  isOpen = false,
  className,
  size = 'sm',
}: FolderIconProps) {
  const { icon: Icon, color } = getFolderIcon(folderName, isOpen);

  return (
    <Icon
      className={cn(SIZE_CLASSES[size], 'flex-shrink-0', color, className)}
      aria-hidden="true"
    />
  );
}
