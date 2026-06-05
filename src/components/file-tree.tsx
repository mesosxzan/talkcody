// src/components/file-tree.tsx
import { ask } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Edit,
  File,
  Folder,
  FolderOpen,
  Globe,
  Plus,
  RefreshCw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useTranslation } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { repositoryService } from '@/services/repository-service';
import { getDirectoryNameFromPath, getFileNameFromPath } from '@/services/repository-utils';
import { useGitStore } from '@/stores/git-store';
import type { FileNode } from '@/types/file-system';
import { GitFileStatus } from '@/types/git';
import { FileIcon } from './file-icon';
import { FolderIcon } from './folder-icon';

// Global state for clipboard operations
type ClipboardOperation = {
  type: 'cut' | 'copy';
  paths: string[];
};

let clipboardState: ClipboardOperation | null = null;

// Helper function to get Git status color for file name
function getGitStatusColor(status: GitFileStatus | null): string {
  if (!status) {
    return '';
  }

  switch (status) {
    case GitFileStatus.Modified:
      return 'git-status-modified'; // Yellow for modified files
    case GitFileStatus.Added:
    case GitFileStatus.Untracked:
      return 'git-status-added'; // Green for new files
    case GitFileStatus.Deleted:
      return 'git-status-deleted'; // Red for deleted files
    case GitFileStatus.Renamed:
      return 'git-status-renamed'; // Purple for renamed files
    case GitFileStatus.Conflicted:
      return 'git-status-conflicted'; // Orange for conflicts
    default:
      return '';
  }
}

// Git status badge component
function GitStatusBadge({ filePath }: { filePath: string }) {
  const getFileStatus = useGitStore((state) => state.getFileStatus);
  const status = getFileStatus(filePath);

  if (!status) {
    return null;
  }

  const getStatusInfo = (status: GitFileStatus) => {
    switch (status) {
      case GitFileStatus.Modified:
        return { label: 'M', className: 'bg-blue-500 text-white' };
      case GitFileStatus.Added:
        return { label: 'A', className: 'bg-green-500 text-white' };
      case GitFileStatus.Deleted:
        return { label: 'D', className: 'bg-red-500 text-white' };
      case GitFileStatus.Renamed:
        return { label: 'R', className: 'bg-purple-500 text-white' };
      case GitFileStatus.Untracked:
        return { label: 'U', className: 'bg-gray-500 text-white' };
      case GitFileStatus.Conflicted:
        return { label: 'C', className: 'bg-orange-500 text-white' };
      default:
        return null;
    }
  };

  const statusInfo = getStatusInfo(status);
  if (!statusInfo) {
    return null;
  }

  return (
    <Badge
      variant="secondary"
      className={cn('ml-2 px-1 py-0 text-xs font-mono', statusInfo.className)}
    >
      {statusInfo.label}
    </Badge>
  );
}

interface FileTreeProps {
  fileTree: FileNode;
  selectedFile: string | null;
  repositoryPath?: string; // Add repository path for relative path calculations
  expandedPaths: Set<string>;
  onFileSelect: (filePath: string) => void;
  onFileDelete?: (filePath: string) => void;
  onFileRename?: (oldPath: string, newName: string) => void;
  onFileCreate?: (parentPath: string, fileName: string, isDirectory: boolean) => void;
  onRefresh?: () => void;
  onLoadChildren?: (node: FileNode) => Promise<FileNode[]>;
  onToggleExpansion?: (path: string) => void;
}

interface FileTreeNodeProps {
  node: FileNode;
  level: number;
  selectedFile: string | null;
  repositoryPath?: string;
  expandedPaths: Set<string>;
  onFileSelect: (filePath: string) => void;
  onFileDelete?: (filePath: string) => void;
  onFileRename?: (oldPath: string, newName: string) => void;
  onFileCreate?: (parentPath: string, fileName: string, isDirectory: boolean) => void;
  onRefresh?: () => void;
  onLoadChildren?: (node: FileNode) => Promise<FileNode[]>;
  onToggleExpansion?: (path: string) => void;
}

// Drop position type for VSCode-like drag indicator
type DropPosition = 'before' | 'after' | 'inside';

function FileTreeNode({
  node,
  level,
  selectedFile,
  repositoryPath,
  expandedPaths,
  onFileSelect,
  onFileDelete,
  onFileRename,
  onFileCreate,
  onRefresh,
  onLoadChildren,
  onToggleExpansion,
}: FileTreeNodeProps) {
  const t = useTranslation();
  // Subscribe to lastRefresh to trigger re-render when Git data changes
  useGitStore((state) => state.lastRefresh); // Triggers re-render when Git status refreshes
  const getFileStatus = useGitStore((state) => state.getFileStatus);

  // Get Git status only for files (not directories) - will update when lastRefresh changes
  const gitStatus = !node.is_directory ? getFileStatus(node.path) : null;
  const fileNameColorClass = getGitStatusColor(gitStatus);

  // Use controlled expansion state from the store
  const isExpanded = expandedPaths.has(node.path);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [renameName, setRenameName] = useState(node.name);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [isLoadingChildren, setIsLoadingChildren] = useState(false);
  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const [_contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuJustClosed = useRef(false);
  const nodeRef = useRef<HTMLButtonElement>(null);
  // Track when rename mode was activated to ignore blur from context-menu dismiss
  const renameActivatedAt = useRef<number>(0);
  // Drag counter to handle dragenter/dragleave correctly
  const dragCounter = useRef(0);
  // Auto-expand timer for drag-over
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track if drag is cancelled by Escape key
  const isDragCancelledRef = useRef(false);

  // Focus input when creating new item
  useEffect(() => {
    if ((isCreatingFile || isCreatingFolder) && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [isCreatingFile, isCreatingFolder]);

  // Scroll selected file into view
  useEffect(() => {
    if (selectedFile === node.path && nodeRef.current) {
      nodeRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [selectedFile, node.path]);

  // Handle Escape key to cancel drag
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDragging) {
        isDragCancelledRef.current = true;
        setIsDragging(false);
      }
    };

    if (isDragging) {
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragging]);

  // Auto-load children when directory is expanded but children are not loaded
  // This handles the case after file tree refresh where expandedPaths is preserved
  // but the tree nodes are re-created with is_lazy_loaded=true
  useEffect(() => {
    if (
      node.is_directory &&
      isExpanded &&
      node.is_lazy_loaded &&
      !isLoadingChildren &&
      onLoadChildren
    ) {
      setIsLoadingChildren(true);
      onLoadChildren(node)
        .then(() => {
          // Children loaded successfully
        })
        .catch((error) => {
          logger.error('Failed to auto-load directory children:', error);
        })
        .finally(() => {
          setIsLoadingChildren(false);
        });
    }
  }, [node, isExpanded, isLoadingChildren, onLoadChildren]);

  const handleToggleDirectory = useCallback(async () => {
    if (node.is_directory && node.is_lazy_loaded && !isExpanded) {
      setIsLoadingChildren(true);
      try {
        if (onLoadChildren) {
          await onLoadChildren(node);
        }
        onToggleExpansion?.(node.path);
      } catch (error) {
        logger.error('Failed to load directory children:', error);
        toast.error(t.FileTree.errors.failedToLoadDirectory);
      } finally {
        setIsLoadingChildren(false);
      }
    } else {
      onToggleExpansion?.(node.path);
    }
  }, [
    node,
    isExpanded,
    onLoadChildren,
    onToggleExpansion,
    t.FileTree.errors.failedToLoadDirectory,
  ]);

  const handleClick = (_e: React.MouseEvent) => {
    // If context menu just closed, ignore this click to prevent accidental actions
    if (contextMenuJustClosed.current) {
      contextMenuJustClosed.current = false;
      return;
    }

    if (isRenaming || isCreatingFile || isCreatingFolder || isLoadingChildren) return;

    if (node.is_directory) {
      handleToggleDirectory();
    } else {
      onFileSelect(node.path);
    }
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    setContextMenuOpen(open);
    if (!open) {
      // Set flag to prevent immediate click after menu closes
      contextMenuJustClosed.current = true;
      // Clear the flag after a short delay
      setTimeout(() => {
        contextMenuJustClosed.current = false;
      }, 100);
    }
  };

  const handleRename = () => {
    setIsRenaming(true);
    setRenameName(node.name);
    renameActivatedAt.current = Date.now();

    // Focus input after state update
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  const handleRenameSubmit = () => {
    // Ignore blur events that fire immediately after rename activation.
    // On Windows, Radix ContextMenu dismisses by firing a pointerdown on the
    // document which can blur the input before the user has a chance to type.
    if (Date.now() - renameActivatedAt.current < 200) {
      // Re-focus the input to keep it alive
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return;
    }

    if (renameName.trim() && renameName !== node.name) {
      onFileRename?.(node.path, renameName.trim());
      toast.success(t.FileTree.success.renamed(renameName));
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = () => {
    setIsRenaming(false);
    setRenameName(node.name);
  };

  const handleDelete = async () => {
    // Prevent multiple delete operations
    if (isDeleting) {
      return;
    }
    setIsDeleting(true);

    try {
      const shouldDelete = await ask(`Are you sure you want to delete ${node.name}?`, {
        title: `Delete ${node.name}`,
        kind: 'warning',
      });

      if (shouldDelete) {
        await repositoryService.deleteFile(node.path);
        onFileDelete?.(node.path);
        toast.success(t.FileTree.success.deleted(node.name));
      }
    } catch (error) {
      logger.error('Failed to delete file:', error);
      toast.error(
        t.FileTree.errors.deleteFailed(
          node.name,
          error instanceof Error ? error.message : 'Unknown error'
        )
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(node.path);
    toast.success(t.FileTree.success.pathCopied);
  };

  const handleCopyRelativePath = () => {
    if (!repositoryPath) {
      toast.error(t.FileTree.errors.repositoryPathNotAvailable);
      return;
    }
    const relativePath = repositoryService.getRelativePath(node.path, repositoryPath);
    navigator.clipboard.writeText(relativePath);
    toast.success(t.FileTree.success.relativePathCopied);
  };

  const handleCut = () => {
    clipboardState = { type: 'cut', paths: [node.path] };
    toast.success(t.FileTree.success.cutToClipboard(node.name));
  };

  const handleCopy = () => {
    clipboardState = { type: 'copy', paths: [node.path] };
    toast.success(t.FileTree.success.copiedToClipboard(node.name));
  };

  const handlePaste = async () => {
    if (!clipboardState || clipboardState.paths.length === 0) {
      toast.error(t.FileTree.errors.nothingToPaste);
      return;
    }

    const targetDir = node.is_directory ? node.path : getDirectoryNameFromPath(node.path);

    try {
      for (const sourcePath of clipboardState.paths) {
        const fileName = getFileNameFromPath(sourcePath);
        let targetPath = `${targetDir}/${fileName}`;

        // Handle name conflicts by adding a suffix
        let counter = 1;
        while (await repositoryService.checkFileExists(targetPath)) {
          const nameWithoutExt =
            fileName.lastIndexOf('.') > 0
              ? fileName.substring(0, fileName.lastIndexOf('.'))
              : fileName;
          const ext =
            fileName.lastIndexOf('.') > 0 ? fileName.substring(fileName.lastIndexOf('.')) : '';
          targetPath = `${targetDir}/${nameWithoutExt}_copy${counter > 1 ? counter : ''}${ext}`;
          counter++;
        }

        if (clipboardState.type === 'cut') {
          await repositoryService.moveFile(sourcePath, targetPath);
          toast.success(t.FileTree.success.moved(fileName));
        } else {
          // Use the new copy method
          await repositoryService.copyFileOrDirectory(sourcePath, targetPath);
          toast.success(t.FileTree.success.copied(fileName));
        }
      }

      if (clipboardState.type === 'cut') {
        clipboardState = null; // Clear clipboard after cut operation
      }

      onRefresh?.();
    } catch (error) {
      logger.error('Paste operation failed:', error);
      toast.error(
        t.FileTree.errors.pasteFailed(error instanceof Error ? error.message : 'Unknown error')
      );
    }
  };

  const handleNewFile = () => {
    // Expand the directory if it's not already expanded
    if (!isExpanded) {
      onToggleExpansion?.(node.path);
    }
    setIsCreatingFile(true);
    setNewItemName('');
  };

  const handleNewFolder = () => {
    // Expand the directory if it's not already expanded
    if (!isExpanded) {
      onToggleExpansion?.(node.path);
    }
    setIsCreatingFolder(true);
    setNewItemName('');
  };

  const handleNewItemSubmit = () => {
    const trimmedName = newItemName.trim();
    if (trimmedName) {
      const parentPath = node.is_directory ? node.path : getDirectoryNameFromPath(node.path);
      const isDirectory = isCreatingFolder;

      onFileCreate?.(parentPath, trimmedName, isDirectory);
      toast.success(
        t.FileTree.success.itemCreated(
          isDirectory ? t.FileTree.contextMenu.newFolder : t.FileTree.contextMenu.newFile
        )
      );
    }

    setIsCreatingFile(false);
    setIsCreatingFolder(false);
    setNewItemName('');
  };

  const handleNewItemCancel = () => {
    setIsCreatingFile(false);
    setIsCreatingFolder(false);
    setNewItemName('');
  };

  const handleRefresh = () => {
    onRefresh?.();
    toast.success(t.FileTree.success.refreshed);
  };

  const handleRevealInFolder = async () => {
    try {
      await revealItemInDir(node.path);
    } catch (error) {
      logger.error('Failed to reveal item in folder:', error);
      toast.error(
        t.FileTree.errors.failedToRevealInFolder(
          error instanceof Error ? error.message : 'Unknown error'
        )
      );
    }
  };

  const handleOpenInBrowser = async () => {
    try {
      await openPath(node.path);
    } catch (error) {
      logger.error('Failed to open file in browser:', error);
      toast.error(
        t.FileTree.errors.failedToOpenInBrowser(
          error instanceof Error ? error.message : 'Unknown error'
        )
      );
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent) => {
    // Prevent dragging during rename or other operations
    if (isRenaming || isCreatingFile || isCreatingFolder) {
      e.preventDefault();
      return;
    }

    setIsDragging(true);
    isDragCancelledRef.current = false;

    // Set drag data with path and directory flag
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({
        path: node.path,
        isDirectory: node.is_directory,
        name: node.name,
      })
    );
    e.dataTransfer.setData('text/plain', node.path);

    // Create a custom drag image with VSCode-like styling
    const dragImage = document.createElement('div');
    dragImage.className =
      'flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-lg ring-1 ring-blue-400/50';
    dragImage.style.opacity = '0.95';

    // Add icon indicator
    const icon = document.createElement('span');
    icon.textContent = node.is_directory ? '📁' : '📄';
    dragImage.appendChild(icon);

    // Add name
    const nameSpan = document.createElement('span');
    nameSpan.textContent = node.name;
    dragImage.appendChild(nameSpan);

    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setIsDragOver(false);
    setDropPosition(null);
    dragCounter.current = 0;

    // Clear auto-expand timer
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
  };

  // Calculate drop position based on mouse Y position relative to the element
  const calculateDropPosition = (e: React.DragEvent): DropPosition | null => {
    if (!nodeRef.current) return null;

    const rect = nodeRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;

    // Top 25% = before, middle 50% = inside (for directories), bottom 25% = after
    if (y < height * 0.25) {
      return 'before';
    }
    if (y > height * 0.75) {
      return 'after';
    }
    // Only directories can have "inside" drop position
    return node.is_directory ? 'inside' : 'after';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if drag was cancelled
    if (isDragCancelledRef.current) return;

    dragCounter.current++;

    if (dragCounter.current === 1) {
      setIsDragOver(true);
      // Calculate and set drop position
      const position = calculateDropPosition(e);
      setDropPosition(position);

      // Auto-expand directory when hovering over it
      if (node.is_directory && !isExpanded && position === 'inside') {
        // Clear any existing timer
        if (autoExpandTimerRef.current) {
          clearTimeout(autoExpandTimerRef.current);
        }
        // Set timer to expand after 500ms (VSCode-like delay)
        autoExpandTimerRef.current = setTimeout(() => {
          if (!isDragCancelledRef.current) {
            onToggleExpansion?.(node.path);
          }
        }, 500);
      }
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounter.current--;

    if (dragCounter.current === 0) {
      setIsDragOver(false);
      setDropPosition(null);

      // Clear auto-expand timer
      if (autoExpandTimerRef.current) {
        clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if drag was cancelled
    if (isDragCancelledRef.current) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    // Update drop position based on current mouse position
    const position = calculateDropPosition(e);
    setDropPosition(position);

    // Set drop effect based on position
    if (position === 'inside' && node.is_directory) {
      e.dataTransfer.dropEffect = 'move';
    } else {
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDropPosition(null);
    dragCounter.current = 0;

    // Clear auto-expand timer
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }

    // Get drag data
    let sourcePath: string;
    let isDirectory: boolean;
    let sourceName: string;

    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (jsonData) {
        const parsed = JSON.parse(jsonData);
        sourcePath = parsed.path;
        isDirectory = parsed.isDirectory;
        sourceName = parsed.name || getFileNameFromPath(sourcePath);
      } else {
        // Fallback to text/plain
        sourcePath = e.dataTransfer.getData('text/plain');
        isDirectory = false;
        sourceName = getFileNameFromPath(sourcePath);
      }
    } catch {
      return;
    }

    if (!sourcePath) return;

    // Determine target based on drop position
    const dropPos = calculateDropPosition(e);
    let targetDir: string;
    let targetName: string;

    if (dropPos === 'inside' && node.is_directory) {
      // Drop inside the directory
      targetDir = node.path;
      targetName = node.name;
    } else {
      // Drop before or after - target is the parent directory
      targetDir = getDirectoryNameFromPath(node.path) || node.path;
      targetName = node.name;
    }

    // Prevent dropping on itself
    if (sourcePath === targetDir || sourcePath === node.path) return;

    // Check if trying to drop a parent folder into its own child
    if (isDirectory && targetDir.startsWith(sourcePath + '/')) {
      toast.error(t.FileTree.errors.cannotMoveIntoChild);
      return;
    }

    // Check if trying to drop into the same directory (when dropping before/after)
    const sourceParentDir = getDirectoryNameFromPath(sourcePath) || '/';
    if ((dropPos === 'before' || dropPos === 'after') && sourceParentDir === targetDir) {
      // Dropping in the same directory, no move needed
      return;
    }

    // Get the file/folder name from source path (use cross-platform helper)
    const fileName = sourceName || getFileNameFromPath(sourcePath);
    const destinationPath = `${targetDir}/${fileName}`;

    try {
      // Check if a file with the same name already exists in the target directory
      if (await repositoryService.checkFileExists(destinationPath)) {
        const shouldOverwrite = await ask(t.FileTree.dragDrop.overwriteConfirm(fileName), {
          title: t.FileTree.dragDrop.overwriteTitle,
          kind: 'warning',
        });

        if (!shouldOverwrite) {
          return;
        }

        // Delete the existing file/folder before moving
        await repositoryService.deleteFile(destinationPath);
      }

      // Move the file/folder
      await repositoryService.moveFile(sourcePath, destinationPath);
      toast.success(t.FileTree.dragDrop.moved(fileName, targetName));

      // Refresh the file tree
      onRefresh?.();
    } catch (error) {
      logger.error('Failed to move file/folder:', error);
      toast.error(
        t.FileTree.dragDrop.moveFailed(error instanceof Error ? error.message : 'Unknown error')
      );
    }
  };

  const isHtmlFile = !node.is_directory && /^(.+)\.(html|htm)$/i.test(node.name);

  const isSelected = selectedFile === node.path;
  const isCut = clipboardState?.type === 'cut' && clipboardState.paths.includes(node.path);
  const isGitIgnored = node.is_git_ignored ?? false;
  // Increased indentation for better visual hierarchy (16px per level)
  const paddingLeft = level * 16;

  const fileTreeItem = (
    <button
      type="button"
      ref={nodeRef}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={cn(
        'group relative flex w-full cursor-pointer items-center border-0 px-2 py-1 text-left text-sm transition-colors duration-150 hover:bg-gray-100 dark:hover:bg-gray-800',
        isSelected && 'bg-blue-100 dark:bg-blue-900/30',
        isCut && 'opacity-50',
        isGitIgnored && 'opacity-60',
        isDragging && 'opacity-40',
        // Highlight when dropping inside a directory
        isDragOver &&
          dropPosition === 'inside' &&
          'bg-blue-200 dark:bg-blue-800/50 ring-2 ring-blue-500 ring-inset'
      )}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
      style={{ paddingLeft: `${paddingLeft + 8}px` }}
    >
      {/* Drop indicator line - VSCode-like visual feedback */}
      {isDragOver && dropPosition === 'before' && (
        <div className="absolute left-2 right-2 top-0 h-0.5 bg-blue-500" />
      )}
      {isDragOver && dropPosition === 'after' && (
        <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-blue-500" />
      )}
      {/* Visual indent guide line for nested items */}
      {level > 0 && (
        <div
          className="absolute left-0 top-0 h-full w-px bg-border/30 group-hover:bg-border/50 dark:bg-border/20 dark:group-hover:bg-border/40"
          style={{ left: `${paddingLeft - 8}px` }}
        />
      )}
      {/* Fixed-width icon container ensures consistent alignment across all items */}
      <div className="flex min-w-0 flex-1 items-center">
        {/* Chevron icon slot - fixed width for alignment */}
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {node.is_directory &&
          (node.has_children || (node.children && node.children.length > 0)) ? (
            isExpanded ? (
              <ChevronDown className={cn('h-3.5 w-3.5', isGitIgnored && 'text-muted-foreground')} />
            ) : (
              <ChevronRight
                className={cn('h-3.5 w-3.5', isGitIgnored && 'text-muted-foreground')}
              />
            )
          ) : null}
        </div>
        {/* File/Folder icon slot - fixed width for alignment */}
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {node.is_directory ? (
            <FolderIcon
              folderName={node.name}
              isOpen={isExpanded}
              className={cn(isGitIgnored && 'opacity-60')}
            />
          ) : (
            <FileIcon filename={node.name} className={cn(isGitIgnored && 'opacity-60')} />
          )}
        </div>

        {isRenaming ? (
          <input
            className="min-w-0 flex-1 rounded border border-blue-500 bg-white px-1 py-0 text-sm dark:bg-gray-800"
            onBlur={handleRenameSubmit}
            onChange={(e) => setRenameName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRenameSubmit();
              } else if (e.key === 'Escape') {
                handleRenameCancel();
              }
            }}
            ref={inputRef}
            type="text"
            value={renameName}
          />
        ) : (
          <>
            <span
              className={cn(
                'truncate',
                fileNameColorClass,
                isGitIgnored && 'text-muted-foreground'
              )}
              title={node.name}
            >
              {node.name}
            </span>
            {!node.is_directory && <GitStatusBadge filePath={node.path} />}
          </>
        )}

        {isLoadingChildren && (
          <span className="ml-2 text-muted-foreground text-xs">{t.FileTree.states.loading}</span>
        )}
      </div>
    </button>
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ContextMenu onOpenChange={handleContextMenuOpenChange}>
        <ContextMenuTrigger asChild>{fileTreeItem}</ContextMenuTrigger>
        <ContextMenuContent>
          {node.is_directory && (
            <>
              <ContextMenuItem onClick={handleNewFile}>
                <FileIcon filename="new-file" className="mr-2 h-4 w-4" />
                {t.FileTree.contextMenu.newFile}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleNewFolder}>
                <FolderIcon folderName="new-folder" isOpen={false} className="mr-2 h-4 w-4" />
                {t.FileTree.contextMenu.newFolder}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={handleCut}>
            <Scissors className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.cut}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopy}>
            <Copy className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.copy}
          </ContextMenuItem>
          {clipboardState && (
            <ContextMenuItem onClick={handlePaste}>
              <ClipboardPaste className="mr-2 h-4 w-4" />
              {t.FileTree.contextMenu.paste}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleRename}>
            <Edit className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.rename}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-red-600 dark:text-red-400"
            disabled={isDeleting}
            onClick={handleDelete}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {isDeleting ? t.FileTree.contextMenu.deleting : t.FileTree.contextMenu.delete}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.copyPath}
          </ContextMenuItem>
          {repositoryPath && (
            <ContextMenuItem onClick={handleCopyRelativePath}>
              <Copy className="mr-2 h-4 w-4" />
              {t.FileTree.contextMenu.copyRelativePath}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleRevealInFolder}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.openInFolder}
          </ContextMenuItem>
          {isHtmlFile && (
            <ContextMenuItem onClick={handleOpenInBrowser}>
              <Globe className="mr-2 h-4 w-4" />
              {t.FileTree.contextMenu.openInBrowser}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleRefresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t.FileTree.contextMenu.refresh}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {node.is_directory && isExpanded && (
        <div>
          {/* Show new item creation input */}
          {(isCreatingFile || isCreatingFolder) && (
            <div
              className="flex cursor-text items-center px-2 py-1 text-sm"
              style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}
            >
              <div className="flex min-w-0 flex-1 items-center">
                {/* Chevron slot - fixed width for alignment */}
                <div className="h-4 w-4 flex-shrink-0" />
                {/* Icon slot - fixed width for alignment */}
                <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {isCreatingFolder ? (
                    <FolderIcon
                      folderName={newItemName || 'new-folder'}
                      isOpen={false}
                      className="text-blue-600"
                    />
                  ) : (
                    <FileIcon filename={newItemName || 'new-file'} />
                  )}
                </div>
                <input
                  className="min-w-0 flex-1 rounded border border-green-500 bg-white px-1 py-0 text-sm dark:bg-gray-800"
                  onBlur={handleNewItemSubmit}
                  onChange={(e) => setNewItemName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleNewItemSubmit();
                    } else if (e.key === 'Escape') {
                      handleNewItemCancel();
                    }
                  }}
                  placeholder={
                    isCreatingFolder
                      ? t.FileTree.placeholder.folderName
                      : t.FileTree.placeholder.fileName
                  }
                  ref={newItemInputRef}
                  type="text"
                  value={newItemName}
                />
              </div>
            </div>
          )}

          {/* Render existing children */}
          {node.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              level={level + 1}
              node={child}
              repositoryPath={repositoryPath}
              expandedPaths={expandedPaths}
              onFileCreate={onFileCreate}
              onFileDelete={onFileDelete}
              onFileRename={onFileRename}
              onFileSelect={onFileSelect}
              onRefresh={onRefresh}
              onLoadChildren={onLoadChildren}
              onToggleExpansion={onToggleExpansion}
              selectedFile={selectedFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  fileTree,
  selectedFile,
  repositoryPath,
  expandedPaths,
  onFileSelect,
  onFileDelete,
  onFileRename,
  onFileCreate,
  onRefresh,
  onLoadChildren,
  onToggleExpansion,
}: FileTreeProps) {
  return (
    <div className="h-full overflow-auto">
      <FileTreeNode
        level={0}
        node={fileTree}
        repositoryPath={repositoryPath}
        expandedPaths={expandedPaths}
        onFileCreate={onFileCreate}
        onFileDelete={onFileDelete}
        onFileRename={onFileRename}
        onFileSelect={onFileSelect}
        onRefresh={onRefresh}
        onLoadChildren={onLoadChildren}
        onToggleExpansion={onToggleExpansion}
        selectedFile={selectedFile}
      />
    </div>
  );
}
