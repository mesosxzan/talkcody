import { Check, ChevronDown, GitBranch, Loader2, Plus, RefreshCw, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';
import { useGitStore } from '@/stores/git-store';

export function GitBranchSelector() {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

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
    }
  }, [open, loadBranches, loadTags, loadRemoteBranches]);

  const handleSelectBranch = useCallback(
    async (branchName: string) => {
      if (branchName === currentBranch) {
        setOpen(false);
        return;
      }

      try {
        await checkoutBranch(branchName);
        toast.success(`Switched to branch: ${branchName}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to branch: ${branchName}`);
      }
    },
    [checkoutBranch, currentBranch]
  );

  const handleSelectTag = useCallback(
    async (tagName: string) => {
      try {
        await checkoutTag(tagName);
        toast.success(`Switched to tag: ${tagName}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to tag: ${tagName}`);
      }
    },
    [checkoutTag]
  );

  const handleSelectRemoteBranch = useCallback(
    async (remoteBranch: string, localName?: string) => {
      try {
        await checkoutRemoteBranch(remoteBranch, localName);
        toast.success(`Switched to remote branch: ${remoteBranch}`);
        setOpen(false);
      } catch {
        toast.error(`Failed to switch to remote branch: ${remoteBranch}`);
      }
    },
    [checkoutRemoteBranch]
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
    async (branchName: string, e: React.MouseEvent) => {
      e.stopPropagation();

      if (branchName === currentBranch) {
        toast.error('Cannot delete the current branch');
        return;
      }

      if (!confirm(`Are you sure you want to delete branch: ${branchName}?`)) {
        return;
      }

      try {
        await deleteBranch(branchName);
        toast.success(`Deleted branch: ${branchName}`);
      } catch {
        toast.error(`Failed to delete branch: ${branchName}`);
      }
    },
    [deleteBranch, currentBranch]
  );

  const handleFetch = useCallback(async () => {
    try {
      const result = await fetch();
      toast.success(result);
    } catch {
      toast.error('Failed to fetch from remote');
    }
  }, [fetch]);

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
                    onClick={() => handleSelectBranch(branch.name)}
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
                          onClick={(e) => handleDeleteBranch(branch.name, e)}
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
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
                          onClick={() => handleSelectRemoteBranch(rb.fullName)}
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
                      className="flex items-center justify-between gap-2 text-xs"
                      key={tag.name}
                      onClick={() => handleSelectTag(tag.name)}
                    >
                      <div className="flex items-center gap-2">
                        <Tag className="h-3 w-3 text-muted-foreground" />
                        <span className="truncate">{tag.name}</span>
                      </div>
                      {tag.isCurrent && (
                        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
