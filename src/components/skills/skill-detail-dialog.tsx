// src/components/skills/skill-detail-dialog.tsx

import { join } from '@tauri-apps/api/path';
import { readTextFile } from '@tauri-apps/plugin-fs';
import {
  BookOpen,
  Calendar,
  Download,
  Edit,
  FileCode,
  FileText,
  Star,
  Trash2,
  User,
  Workflow,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/hooks/use-locale';
import { logger } from '@/lib/logger';
import type { Skill } from '@/types/skill';

interface SkillDetailDialogProps {
  skill: Skill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onEdit?: (skill: Skill) => void;
  onDelete?: (skill: Skill) => void;
  onInstall?: (skill: Skill) => void;
  isInstalled?: boolean; // Explicitly indicate if skill is already installed locally
}

export function SkillDetailDialog({
  skill,
  open,
  onOpenChange,
  onClose,
  onEdit,
  onDelete,
  onInstall,
  isInstalled = false,
}: SkillDetailDialogProps) {
  const t = useTranslation();
  const [activeTab, setActiveTab] = useState('overview');
  const [isInstalling, setIsInstalling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedScript, setSelectedScript] = useState<string | null>(null);
  const [scriptContent, setScriptContent] = useState<string>('');
  const [isLoadingScript, setIsLoadingScript] = useState(false);

  const hasMarketplaceData = Boolean(skill.marketplace);
  // A skill is considered local (editable/deletable) if it's installed locally
  // This is determined by the isInstalled prop or by not having marketplace data
  const isLocalSkill = isInstalled || !hasMarketplaceData;
  // Show install button only for marketplace skills that are NOT installed yet
  const showInstallButton = hasMarketplaceData && !isInstalled;

  // Helper function to infer script type from filename
  const inferScriptType = (filename: string): string => {
    const ext = filename.toLowerCase().split('.').pop();
    switch (ext) {
      case 'py':
        return 'python';
      case 'sh':
        return 'bash';
      case 'js':
        return 'nodejs';
      case 'ts':
        return 'typescript';
      default:
        return 'unknown';
    }
  };

  // Get full script path
  const getScriptPath = (scriptFile: string): string | null => {
    if (!skill.localPath) {
      return null;
    }
    return `${skill.localPath}/scripts/${scriptFile}`;
  };

  // Load script content when a script is selected
  useEffect(() => {
    const loadScriptContent = async () => {
      if (!selectedScript) {
        setScriptContent('');
        return;
      }

      // For file-based skills, we need the local path
      if (!skill.localPath) {
        setScriptContent('// Script preview not available - localPath not found');
        return;
      }

      try {
        setIsLoadingScript(true);
        const scriptPath = await join(skill.localPath, 'scripts', selectedScript);
        const content = await readTextFile(scriptPath);
        setScriptContent(content);
      } catch (error) {
        logger.error('Failed to load script content:', error);
        setScriptContent(`// Failed to load script content\n// Error: ${error}`);
      } finally {
        setIsLoadingScript(false);
      }
    };

    loadScriptContent();
  }, [selectedScript, skill.localPath]);

  const handleInstall = async () => {
    if (!onInstall) return;

    try {
      setIsInstalling(true);
      await onInstall(skill);
      onClose();
    } catch (error) {
      logger.error('Failed to install skill:', error);
      toast.error(t.Skills.detail.installFailed);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleEdit = () => {
    if (onEdit) {
      onEdit(skill);
      onClose();
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    if (!confirm(t.Skills.detail.deleteConfirm)) {
      return;
    }

    try {
      setIsDeleting(true);
      await onDelete(skill);
      toast.success(t.Skills.detail.deleteSuccess);
      onClose();
    } catch (error) {
      logger.error('Failed to delete skill:', error);
      toast.error(t.Skills.detail.deleteFailed);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-fit min-w-4/5 max-h-[80vh] flex flex-col">
        {/* Header */}
        <DialogHeader className="p-6 pb-0 flex-shrink-0">
          <div className="flex items-start gap-4">
            {skill.icon ? (
              <img
                src={skill.icon}
                alt={skill.name}
                className="w-16 h-16 rounded-lg object-cover"
              />
            ) : (
              <div className="w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center">
                <Zap className="h-8 w-8 text-primary" />
              </div>
            )}

            <div className="flex-1 min-w-0">
              <DialogTitle className="text-2xl">{skill.name}</DialogTitle>
              <DialogDescription className="mt-2">{skill.description}</DialogDescription>

              <div className="flex items-center gap-2 mt-3">
                <Badge variant="outline">{skill.category}</Badge>
                {skill.metadata.isBuiltIn && (
                  <Badge variant="secondary">{t.Skills.detail.builtIn}</Badge>
                )}
                {skill.marketplace && (
                  <Badge variant="default">{t.Skills.detail.marketplace}</Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0"
        >
          <div className="border-b px-6 flex-shrink-0">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="overview">{t.Skills.detail.overview}</TabsTrigger>
              <TabsTrigger value="content">{t.Skills.detail.content}</TabsTrigger>
              {skill.content.scriptFiles && skill.content.scriptFiles.length > 0 && (
                <TabsTrigger value="scripts">{t.Skills.detail.scripts}</TabsTrigger>
              )}
              <TabsTrigger value="stats">{t.Skills.detail.stats}</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6">
              <TabsContent value="overview" className="mt-4 space-y-4 mb-4">
                {/* Long Description */}
                {skill.longDescription && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.description}</h3>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {skill.longDescription}
                    </p>
                  </div>
                )}

                {/* Marketplace Info */}
                {skill.marketplace && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.marketplaceInfo}</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span>
                          {t.Skills.detail.author} {skill.marketplace.author}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Download className="h-4 w-4 text-muted-foreground" />
                        <span>
                          {skill.marketplace.downloads.toLocaleString()} {t.Skills.detail.downloads}
                        </span>
                      </div>
                      {skill.marketplace.rating > 0 && (
                        <div className="flex items-center gap-2">
                          <Star className="h-4 w-4 text-muted-foreground" />
                          <span>
                            {skill.marketplace.rating.toFixed(1)} {t.Skills.detail.rating}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>
                          {t.Skills.detail.version} {skill.marketplace.version}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Contents Summary */}
                <div>
                  <h3 className="font-semibold mb-2">{t.Skills.detail.contents}</h3>
                  <div className="space-y-2 text-sm">
                    {skill.content.systemPromptFragment && (
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-primary" />
                        <span>
                          {t.Skills.detail.systemPromptFragment} (
                          {skill.content.systemPromptFragment.length} chars)
                        </span>
                      </div>
                    )}
                    {skill.content.workflowRules && (
                      <div className="flex items-center gap-2">
                        <Workflow className="h-4 w-4 text-primary" />
                        <span>
                          {t.Skills.detail.workflowRules} ({skill.content.workflowRules.length}{' '}
                          chars)
                        </span>
                      </div>
                    )}
                    {skill.content.documentation && skill.content.documentation.length > 0 && (
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-4 w-4 text-primary" />
                        <span>
                          {t.Skills.detail.documentation} ({skill.content.documentation.length}{' '}
                          items)
                        </span>
                      </div>
                    )}
                    {skill.content.scriptFiles && skill.content.scriptFiles.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        <span>
                          {t.Skills.detail.scripts} ({skill.content.scriptFiles.length} files)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Tags */}
                {skill.metadata.tags && skill.metadata.tags.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.tags}</h3>
                    <div className="flex flex-wrap gap-1">
                      {skill.metadata.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="content" className="mt-4 space-y-4 mb-4">
                {/* System Prompt */}
                {skill.content.systemPromptFragment && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.systemPromptFragment}</h3>
                    <div className="bg-muted p-4 rounded-md text-sm font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                      {skill.content.systemPromptFragment}
                    </div>
                  </div>
                )}

                {/* Workflow Rules */}
                {skill.content.workflowRules && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.workflowRules}</h3>
                    <div className="bg-muted p-4 rounded-md text-sm font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                      {skill.content.workflowRules}
                    </div>
                  </div>
                )}

                {/* Documentation */}
                {skill.content.documentation && skill.content.documentation.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-2">{t.Skills.detail.documentation}</h3>
                    <div className="space-y-2">
                      {skill.content.documentation.map((doc, index) => (
                        <div
                          key={`${doc.title}-${doc.type}-${index}`}
                          className="border rounded-md p-3 text-sm"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <BookOpen className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{doc.title}</span>
                            <Badge variant="outline" className="text-xs">
                              {doc.type}
                            </Badge>
                          </div>
                          {doc.type === 'url' && doc.url && (
                            <p className="text-xs text-muted-foreground truncate">{doc.url}</p>
                          )}
                          {doc.type === 'file' && doc.filePath && (
                            <p className="text-xs text-muted-foreground truncate">{doc.filePath}</p>
                          )}
                          {doc.type === 'inline' && doc.content && (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {doc.content}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* Scripts Tab */}
              <TabsContent value="scripts" className="mt-4 space-y-4 mb-4">
                {skill.content.scriptFiles && skill.content.scriptFiles.length > 0 ? (
                  <div className="space-y-4">
                    {/* Script List */}
                    <div>
                      <h3 className="font-semibold mb-2">{t.Skills.detail.availableScripts}</h3>
                      <div className="space-y-2">
                        {skill.content.scriptFiles.map((scriptFile) => (
                          <button
                            key={scriptFile}
                            type="button"
                            className={`w-full border rounded-md p-3 text-sm text-left hover:bg-accent transition-colors ${
                              selectedScript === scriptFile ? 'border-primary bg-accent' : ''
                            }`}
                            onClick={() => setSelectedScript(scriptFile)}
                          >
                            <div className="flex items-center gap-2">
                              <FileCode className="h-4 w-4 text-muted-foreground" />
                              <span className="font-medium">{scriptFile}</span>
                              <Badge variant="outline" className="text-xs">
                                {inferScriptType(scriptFile)}
                              </Badge>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Script Preview */}
                    {selectedScript && (
                      <div>
                        <h3 className="font-semibold mb-2">{t.Skills.detail.scriptPreview}</h3>
                        <div className="space-y-2">
                          <div className="text-xs text-muted-foreground">
                            {t.Skills.detail.path}:{' '}
                            {getScriptPath(selectedScript) || `scripts/${selectedScript}`}
                          </div>
                          <div className="bg-muted p-4 rounded-md text-sm font-mono whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
                            {isLoadingScript ? t.Skills.card.loading : scriptContent}
                          </div>
                          {getScriptPath(selectedScript) && (
                            <div className="text-xs text-muted-foreground break-all">
                              {t.Skills.detail.executeWith}: execute_skill_script(script_path="
                              {getScriptPath(selectedScript)}", script_type="
                              {inferScriptType(selectedScript)}")
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">{t.Skills.detail.noScripts}</div>
                )}
              </TabsContent>

              <TabsContent value="stats" className="mt-4 space-y-4 mb-4">
                <div>
                  <h3 className="font-semibold mb-2">{t.Skills.detail.usageStatistics}</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t.Skills.detail.created}</span>
                      <span>{new Date(skill.metadata.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t.Skills.detail.updated}</span>
                      <span>{new Date(skill.metadata.updatedAt).toLocaleDateString()}</span>
                    </div>
                    {skill.metadata.lastUsed && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t.Skills.detail.lastUsed}</span>
                        <span>{new Date(skill.metadata.lastUsed).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>

        <Separator className="flex-shrink-0" />

        {/* Footer */}
        <DialogFooter className="p-6 pt-4 flex-shrink-0">
          <div className="flex items-center gap-2 w-full">
            {isLocalSkill && onEdit && (
              <Button variant="outline" size="sm" onClick={handleEdit}>
                <Edit className="h-4 w-4 mr-2" />
                {t.Skills.detail.edit}
              </Button>
            )}
            {isLocalSkill && onDelete && (
              <Button variant="outline" size="sm" onClick={handleDelete} disabled={isDeleting}>
                <Trash2 className="h-4 w-4 mr-2" />
                {isDeleting ? t.Skills.detail.deleting : t.Skills.detail.delete}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="outline" onClick={onClose}>
              {t.Skills.detail.close}
            </Button>
            {showInstallButton && onInstall && (
              <Button onClick={handleInstall} disabled={isInstalling}>
                {isInstalling ? t.Skills.detail.installing : t.Skills.detail.install}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
