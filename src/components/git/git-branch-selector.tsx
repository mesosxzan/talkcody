import { Check, ChevronDown, GitBranch, Loader2, Tag } from 'lucide-react';
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
  const branches = useGitStore((state) => state.branches);
  const tags = useGitStore((state) => state.tags);
  const isLoadingBranches = useGitStore((state) => state.isLoadingBranches);
  const isLoadingTags = useGitStore((state) => state.isLoadingTags);
  const gitStatus = useGitStore((state) => state.gitStatus);
  const loadBranches = useGitStore((state) => state.loadBranches);
  const loadTags = useGitStore((state) => state.loadTags);
  const checkoutBranch = useGitStore((state) => state.checkoutBranch);
  const checkoutTag = useGitStore((state) => state.checkoutTag);

  const currentBranch = gitStatus?.branch?.name;
  const isDetachedHead = gitStatus?.branch?.isHead;

  // Load branches and tags when dropdown opens
  useEffect(() => {
    if (open) {
      loadBranches();
      loadTags();
      setSearchQuery('');
    }
  }, [open, loadBranches, loadTags]);

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

  const isLoading = isLoadingBranches || isLoadingTags;

  // Filter branches and tags based on search query
  const filteredBranches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredTags = tags.filter((tag) =>
    tag.name.toLowerCase().includes(searchQuery.toLowerCase())
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
      <DropdownMenuContent align="start" className="w-56 p-0">
        {/* Search Input */}
        <div className="p-2">
          <Input
            className="h-7 text-xs"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            value={searchQuery}
          />
        </div>

        <DropdownMenuSeparator />

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ScrollArea className="h-64">
            {/* Branches */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                Branches
              </DropdownMenuLabel>
              {filteredBranches.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {searchQuery ? 'No matching branches' : 'No branches'}
                </div>
              ) : (
                filteredBranches.map((branch) => (
                  <DropdownMenuItem
                    className="flex items-center justify-between gap-2 text-xs"
                    key={branch.name}
                    onClick={() => handleSelectBranch(branch.name)}
                  >
                    <div className="flex items-center gap-2">
                      <GitBranch className="h-3 w-3 text-muted-foreground" />
                      <span className="truncate">{branch.name}</span>
                    </div>
                    {branch.isCurrent && (
                      <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>

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
