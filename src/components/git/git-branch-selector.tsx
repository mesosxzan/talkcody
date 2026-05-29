import {
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '@/hooks/use-locale';
import { cn } from '@/lib/utils';
import { useGitStore } from '@/stores/git-store';

export function GitBranchSelector() {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [tagMessage, setTagMessage] = useState('');
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [pushingBranch, setPushingBranch] = useState<string | null>(null);
  const [showMergeBranch, setShowMergeBranch] = useState(false);
  const [mergeBranchName, setMergeBranchName] = useState('');
  const [mergeMessage, setMergeMessage] = useState('');
  const [useNoFF, setUseNoFF] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  /** Lock to prevent duplicate branch/tag checkout operations */
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  /** Delete branch confirmation dialog state */
  const [deleteBranchDialog, setDeleteBranchDialog] = useState<{
    open: boolean;
    branchName: string;
  }>({ open: false, branchName: '' });
  const [isDeletingBranch, setIsDeletingBranch] = useState(false);

  const t = useTranslation();

  const branches = useGitStore((state) => state.branches);
  const tags = useGitStore((state) => state.tags);
  const remoteBranches = useGitStore((state) => state.remoteBranches);
  const isLoadingBranches = useGitStore((state) => state.isLoadingBranches);
  const isLoadingTags = useGitStore((state) => state.isLoadingTags);
  const isLoadingRemoteBranches = useGitStore((state) => state.isLoadingRemoteBranches);
  const isFetching = useGitStore((state) => state.isFetching);
  const gitStatus = useGitStore((state) => state.gitStatus);
  const loadBranches = useGitStore((state) => state.loadBranches);
  const loadTags = useGitStore((state) => state.loadTags);
  const loadRemoteBranches = useGitStore((state) => state.loadRemoteBranches);
  const checkoutBranch = useGitStore((state) => state.checkoutBranch);
  const checkoutTag = useGitStore((state) => state.checkoutTag);
  const createBranch = useGitStore((state) => state.createBranch);
  const checkoutRemoteBranch = useGitStore((state) => state.checkoutRemoteBranch);
  const deleteBranch = useGitStore((state) => state.deleteBranch);
  const pushBranch = useGitStore((state) => state.pushBranch);
  const createTag = useGitStore((state) => state.createTag);
  const pushTag = useGitStore((state) => state.pushTag);
  const deleteTag = useGitStore((state) => state.deleteTag);
  const mergeBranch = useGitStore((state) => state.mergeBranch);
  const fetch = useGitStore((state) => state.fetch);

  const currentBranch = gitStatus?.branch?.name;
  const isDetachedHead = gitStatus?.branch?.isHead;

  // Load branches and tags when dropdown opens
  useEffect(() => {
    if (open) {
      loadBranches();
      loadTags();
      loadRemoteBranches();
      setSearchQuery('');
      setShowCreateBranch(false);
      setNewBranchName('');
      setShowCreateTag(false);
      setNewTagName('');
      setTagMessage('');
      setShowMergeBranch(false);
      setMergeBranchName('');
      setMergeMessage('');
      setUseNoFF(false);
    }
  }, [open, loadBranches, loadTags, loadRemoteBranches]);

  const handleSelectBranch = useCallback(
    async (branchName: string) => {
      // Prevent duplicate checkout or switching to the same branch
      if (isCheckingOut || branchName === currentBranch) {
        setOpen(false);
        return;
      }

      setIsCheckingOut(true);
      try {
        await checkoutBranch(branchName);
        toast.success(`Switched to branch: ${branchName}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to branch: ${branchName}`);
      } finally {
        setIsCheckingOut(false);
      }
    },
    [checkoutBranch, currentBranch, isCheckingOut]
  );

  const handleSelectTag = useCallback(
    async (tagName: string) => {
      // Prevent duplicate checkout
      if (isCheckingOut) {
        setOpen(false);
        return;
      }

      setIsCheckingOut(true);
      try {
        await checkoutTag(tagName);
        toast.success(`Switched to tag: ${tagName}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to tag: ${tagName}`);
      } finally {
        setIsCheckingOut(false);
      }
    },
    [checkoutTag, isCheckingOut]
  );

  const handleSelectRemoteBranch = useCallback(
    async (remoteBranch: string, localName?: string) => {
      // Prevent duplicate checkout
      if (isCheckingOut) {
        setOpen(false);
        return;
      }

      setIsCheckingOut(true);
      try {
        await checkoutRemoteBranch(remoteBranch, localName);
        toast.success(`Switched to remote branch: ${remoteBranch}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to remote branch: ${remoteBranch}`);
      } finally {
        setIsCheckingOut(false);
      }
    },
    [checkoutRemoteBranch, isCheckingOut]
  );

  const handleCreateBranch = useCallback(
    async (branchName: string) => {
      if (!branchName.trim()) {
        toast.error('Branch name cannot be empty');
        return;
      }

      setIsCreating(true);
      try {
        await createBranch(branchName);
        toast.success(`Created and switched to branch: ${branchName}`);
        setShowCreateBranch(false);
        setNewBranchName('');
        setOpen(false);
      } catch {
        toast.error(`Failed to create branch: ${branchName}`);
      } finally {
        setIsCreating(false);
      }
    },
    [createBranch]
  );

  const handleDeleteBranch = useCallback(
    (branchName: string) => {
      if (branchName === currentBranch) {
        toast.error(t.Git.cannotDeleteCurrentBranch);
        return;
      }

      // Open confirmation dialog instead of using browser confirm()
      setDeleteBranchDialog({ open: true, branchName });
    },
    [currentBranch, t]
  );

  const handleConfirmDeleteBranch = useCallback(async () => {
    const { branchName } = deleteBranchDialog;
    if (!branchName) return;

    setIsDeletingBranch(true);
    try {
      await deleteBranch(branchName);
      toast.success(`${t.Git.deletedBranch}: ${branchName}`);
      setDeleteBranchDialog({ open: false, branchName: '' });
    } catch {
      toast.error(`${t.Git.failedToDeleteBranch}: ${branchName}`);
    } finally {
      setIsDeletingBranch(false);
    }
  }, [deleteBranchDialog, deleteBranch, t]);

  const handleCancelDeleteBranch = useCallback(() => {
    setDeleteBranchDialog({ open: false, branchName: '' });
  }, []);

  const handleFetch = useCallback(async () => {
    try {
      const result = await fetch();
      toast.success(result);
    } catch {
      toast.error('Failed to fetch from remote');
    }
  }, [fetch]);

  const handlePushBranch = useCallback(
    async (branchName: string) => {
      if (!confirm(`Push branch "${branchName}" to remote?`)) {
        return;
      }

      setPushingBranch(branchName);
      try {
        const result = await pushBranch(branchName, undefined, true);
        toast.success(result);
      } catch {
        toast.error(`Failed to push branch: ${branchName}`);
      } finally {
        setPushingBranch(null);
      }
    },
    [pushBranch]
  );

  const handleCreateTag = useCallback(
    async (tagName: string, message: string) => {
      if (!tagName.trim()) {
        toast.error('Tag name cannot be empty');
        return;
      }

      setIsCreatingTag(true);
      try {
        await createTag(tagName, message || undefined);
        toast.success(`Created tag: ${tagName}`);
        setShowCreateTag(false);
        setNewTagName('');
        setTagMessage('');
      } catch {
        toast.error(`Failed to create tag: ${tagName}`);
      } finally {
        setIsCreatingTag(false);
      }
    },
    [createTag]
  );

  const handlePushTag = useCallback(
    async (tagName: string) => {
      if (!confirm(`Push tag "${tagName}" to remote?`)) {
        return;
      }

      try {
        const result = await pushTag(tagName);
        toast.success(result);
      } catch {
        toast.error(`Failed to push tag: ${tagName}`);
      }
    },
    [pushTag]
  );

  const handleDeleteTag = useCallback(
    async (tagName: string) => {
      if (!confirm(`Delete tag "${tagName}"?\n\nThis will delete both local and remote tag.`)) {
        return;
      }

      try {
        await deleteTag(tagName, 'origin');
        toast.success(`Deleted tag: ${tagName}`);
      } catch {
        toast.error(`Failed to delete tag: ${tagName}`);
      }
    },
    [deleteTag]
  );

  const handleMergeBranch = useCallback(
    async (branchName: string, noFF: boolean, message?: string) => {
      if (!branchName.trim()) {
        toast.error('Please select a branch to merge');
        return;
      }

      if (branchName === currentBranch) {
        toast.error('Cannot merge a branch into itself');
        return;
      }

      setIsMerging(true);
      try {
        const result = await mergeBranch(branchName, noFF, message);
        toast.success(result);
        setShowMergeBranch(false);
        setMergeBranchName('');
        setMergeMessage('');
        setUseNoFF(false);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('CONFLICT')) {
          toast.error('Merge conflict detected. Please resolve conflicts and commit.');
        } else {
          toast.error(`Failed to merge branch: ${branchName}`);
        }
      } finally {
        setIsMerging(false);
      }
    },
    [mergeBranch, currentBranch]
  );

  const isLoading = isLoadingBranches || isLoadingTags || isLoadingRemoteBranches;

  // Filter branches and tags based on search query
  const filteredBranches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredTags = tags.filter((tag) =>
    tag.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredRemoteBranches = remoteBranches.filter((rb) =>
    rb.fullName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group remote branches by remote name
  const groupedRemoteBranches = filteredRemoteBranches.reduce(
    (acc, rb) => {
      if (!acc[rb.remote]) {
        acc[rb.remote] = [];
      }
      acc[rb.remote]?.push(rb);
      return acc;
    },
    {} as Record<string, typeof remoteBranches>
  );

  return (
    <>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-6 justify-between gap-1 px-2 text-xs font-medium"
            size="sm"
            variant="ghost"
          >
            <GitBranch className="h-3 w-3" />
            <span className={cn(isDetachedHead && 'text-amber-600 dark:text-amber-400')}>
              {currentBranch || 'No branch'}
            </span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-0">
          {/* Header with actions */}
          <div className="flex items-center justify-between gap-2 border-b p-2">
            <div className="flex-1">
              <Input
                className="h-7 text-xs"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search branches..."
                value={searchQuery}
              />
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={handleFetch}
                disabled={isFetching}
                title="Fetch from remote"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => setShowCreateBranch(!showCreateBranch)}
                title="Create new branch"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => setShowCreateTag(!showCreateTag)}
                title="Create new tag"
              >
                <Tag className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => setShowMergeBranch(!showMergeBranch)}
                title="Merge branch"
              >
                <GitMerge className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Create branch input */}
          {showCreateBranch && (
            <div className="border-b p-2">
              <div className="flex gap-2">
                <Input
                  className="h-7 flex-1 text-xs"
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCreateBranch(newBranchName);
                    }
                  }}
                  placeholder="Branch name"
                  value={newBranchName}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!newBranchName.trim() || isCreating}
                  onClick={() => handleCreateBranch(newBranchName)}
                >
                  {isCreating ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create'}
                </Button>
              </div>
            </div>
          )}

          {/* Create tag input */}
          {showCreateTag && (
            <div className="border-b p-2 space-y-2">
              <Input
                className="h-7 text-xs"
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Tag name (e.g., v1.0.0)"
                value={newTagName}
              />
              <Input
                className="h-7 text-xs"
                onChange={(e) => setTagMessage(e.target.value)}
                placeholder="Tag message (optional)"
                value={tagMessage}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  disabled={!newTagName.trim() || isCreatingTag}
                  onClick={() => handleCreateTag(newTagName, tagMessage)}
                >
                  {isCreatingTag ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create Tag'}
                </Button>
              </div>
            </div>
          )}

          {/* Merge branch input */}
          {showMergeBranch && (
            <div className="border-b p-2 space-y-2">
              <select
                className="w-full h-7 text-xs px-2 border rounded"
                onChange={(e) => setMergeBranchName(e.target.value)}
                value={mergeBranchName}
              >
                <option value="">Select branch to merge...</option>
                {filteredBranches
                  .filter((b) => b.name !== currentBranch)
                  .map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
              <Input
                className="h-7 text-xs"
                onChange={(e) => setMergeMessage(e.target.value)}
                placeholder="Merge message (optional)"
                value={mergeMessage}
              />
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={useNoFF}
                  className="h-3 w-3"
                  onChange={(e) => setUseNoFF(e.target.checked)}
                />
                <span className="text-xs">No fast-forward</span>
              </div>
              <Button
                size="sm"
                className="h-7 w-full text-xs"
                disabled={!mergeBranchName || isMerging}
                onClick={() =>
                  handleMergeBranch(mergeBranchName, useNoFF, mergeMessage || undefined)
                }
              >
                {isMerging ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Merge Branch'}
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ScrollArea className="h-80">
              {/* Local Branches */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                  Local Branches
                </DropdownMenuLabel>
                {filteredBranches.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {searchQuery ? 'No matching branches' : 'No branches'}
                  </div>
                ) : (
                  filteredBranches.map((branch) => (
                    <DropdownMenuItem
                      className="group flex items-center justify-between gap-2 text-xs"
                      key={branch.name}
                      onSelect={() => handleSelectBranch(branch.name)}
                    >
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-3 w-3 text-muted-foreground" />
                        <span className="truncate">{branch.name}</span>
                        {branch.upstream && (
                          <span className="text-muted-foreground">→ {branch.upstream}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {branch.isCurrent && (
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                        )}
                        {!branch.isCurrent && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            data-action="delete"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDeleteBranch(branch.name);
                            }}
                            disabled={
                              isDeletingBranch && deleteBranchDialog.branchName === branch.name
                            }
                          >
                            {isDeletingBranch && deleteBranchDialog.branchName === branch.name ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                            )}
                          </Button>
                        )}
                        {!branch.upstream && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            data-action="push"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handlePushBranch(branch.name);
                            }}
                            disabled={pushingBranch === branch.name}
                          >
                            {pushingBranch === branch.name ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Upload className="h-3 w-3 text-muted-foreground" />
                            )}
                          </Button>
                        )}
                      </div>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuGroup>

              {/* Remote Branches */}
              {Object.keys(groupedRemoteBranches).length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                      Remote Branches
                    </DropdownMenuLabel>
                    {Object.entries(groupedRemoteBranches).map(([remote, branches]) => (
                      <div key={remote}>
                        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                          {remote}
                        </div>
                        {branches?.map((rb) => (
                          <DropdownMenuItem
                            className="flex items-center gap-2 text-xs"
                            key={rb.fullName}
                            onSelect={() => handleSelectRemoteBranch(rb.fullName)}
                          >
                            <GitBranch className="h-3 w-3 text-muted-foreground" />
                            <span className="truncate">{rb.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    ))}
                  </DropdownMenuGroup>
                </>
              )}

              {/* Tags */}
              {filteredTags.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                      Tags
                    </DropdownMenuLabel>
                    {filteredTags.map((tag) => (
                      <DropdownMenuItem
                        className="group flex items-center justify-between gap-2 text-xs"
                        key={tag.name}
                        onSelect={() => handleSelectTag(tag.name)}
                      >
                        <div className="flex items-center gap-2">
                          <Tag className="h-3 w-3 text-muted-foreground" />
                          <span className="truncate">{tag.name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {tag.isCurrent && (
                            <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            data-action="push-tag"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handlePushTag(tag.name);
                            }}
                          >
                            <Upload className="h-3 w-3 text-muted-foreground" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            data-action="delete-tag"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDeleteTag(tag.name);
                            }}
                          >
                            <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                          </Button>
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </>
              )}
            </ScrollArea>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete branch confirmation dialog */}
      <AlertDialog
        open={deleteBranchDialog.open}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            handleCancelDeleteBranch();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.Git.deleteBranch}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.Git.deleteBranchConfirm}
              <strong className="mx-1 text-foreground">{deleteBranchDialog.branchName}</strong>
              {t.Git.deleteBranchDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingBranch}>{t.Git.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteBranch}
              disabled={isDeletingBranch}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingBranch ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t.Git.deleting}
                </>
              ) : (
                t.Git.deleteBranch
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
