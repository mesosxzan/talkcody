import { useRepositoryStore } from '@/stores/window-scoped-repository-store';
import { GitCommitPanel } from './git-commit-panel';

export function GitPanel() {
  const openDiffFile = useRepositoryStore((state) => state.openDiffFile);

  const handleFileClick = (filePath: string) => {
    // Open diff in main editor area
    openDiffFile(filePath);
  };

  return <GitCommitPanel onFileClick={handleFileClick} />;
}
