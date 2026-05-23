// Local agent detail dialog

import { Bot, Calendar, Package, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/hooks/use-locale';
import type { Agent } from '@/types';
import { MODEL_TYPE_LABELS } from '@/types/model-types';

interface LocalAgentDetailDialogProps {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
}

export function LocalAgentDetailDialog({
  agent,
  open,
  onClose,
  onEdit,
}: LocalAgentDetailDialogProps) {
  const t = useTranslation();
  const isSystemAgent = agent.source_type === 'system';
  const isMarketplaceAgent = agent.source_type === 'marketplace';

  // Parse JSON fields
  const categories = agent.categories ? JSON.parse(agent.categories) : [];
  const tags = agent.tags ? JSON.parse(agent.tags) : [];
  const toolsConfig = agent.tools_config ? JSON.parse(agent.tools_config) : {};
  const toolNames = Object.keys(toolsConfig);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-fit min-w-4/5 max-h-[80vh] overflow-y-auto flex flex-col">
        <DialogHeader>
          <div className="flex items-start gap-4">
            {agent.icon_url ? (
              <img
                src={agent.icon_url}
                alt={agent.name}
                className="w-16 h-16 rounded-md object-cover"
              />
            ) : (
              <div className="w-16 h-16 rounded-md bg-primary/10 flex items-center justify-center">
                <Bot className="h-8 w-8 text-primary" />
              </div>
            )}

            <div className="flex-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-2xl">{agent.name}</DialogTitle>
                {isSystemAgent && <Badge variant="secondary">{t.Agents.card.system}</Badge>}
                {isMarketplaceAgent && <Badge variant="outline">{t.Agents.card.installed}</Badge>}
                {!agent.is_enabled && (
                  <Badge variant="outline" className="opacity-60">
                    {t.Agents.card.inactive}
                  </Badge>
                )}
              </div>
              <DialogDescription className="mt-1">
                {agent.description || t.Agents.detail.noDescription}
              </DialogDescription>

              <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Package className="h-4 w-4" />
                  {agent.model_type
                    ? MODEL_TYPE_LABELS[agent.model_type as keyof typeof MODEL_TYPE_LABELS] ||
                      agent.model_type
                    : 'Main Model'}
                </div>

                <div className="flex items-center gap-1">
                  <Settings className="h-4 w-4" />
                  {t.Agents.detail.toolsCount(toolNames.length)}
                </div>

                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {t.Agents.detail.usedTimes(agent.usage_count)}
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="overview">{t.Agents.detail.overview}</TabsTrigger>
            <TabsTrigger value="configuration">{t.Agents.detail.configuration}</TabsTrigger>
            <TabsTrigger value="tools">{t.Agents.detail.tools}</TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 pr-4">
            <TabsContent value="overview" className="mt-4 space-y-4">
              {/* Source Information */}
              <div>
                <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.source}</h3>
                <div className="text-sm space-y-1">
                  <div>
                    <span className="text-muted-foreground">{t.Agents.detail.type}:</span>{' '}
                    <span className="capitalize">{agent.source_type}</span>
                  </div>
                  {agent.created_by && (
                    <div>
                      <span className="text-muted-foreground">{t.Agents.detail.createdBy}:</span>{' '}
                      {agent.created_by}
                    </div>
                  )}
                  {agent.marketplace_id && (
                    <div>
                      <span className="text-muted-foreground">
                        {t.Agents.detail.marketplaceId}:
                      </span>{' '}
                      {agent.marketplace_id}
                    </div>
                  )}
                  {agent.marketplace_version && (
                    <div>
                      <span className="text-muted-foreground">{t.Agents.detail.version}:</span>{' '}
                      {agent.marketplace_version}
                    </div>
                  )}
                </div>
              </div>

              {/* Categories */}
              {categories.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.categories}</h3>
                  <div className="flex flex-wrap gap-2">
                    {categories.map((category: string) => (
                      <Badge key={category} variant="secondary">
                        {category}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Tags */}
              {tags.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.tags}</h3>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag: string) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Statistics */}
              <div>
                <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.statistics}</h3>
                <div className="text-sm space-y-1">
                  <div>
                    <span className="text-muted-foreground">{t.Agents.detail.usageCount}:</span>{' '}
                    {agent.usage_count}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t.Agents.detail.created}:</span>{' '}
                    {new Date(agent.created_at).toLocaleString()}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t.Agents.detail.lastUpdated}:</span>{' '}
                    {new Date(agent.updated_at).toLocaleString()}
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t.Agents.detail.status}:</span>{' '}
                    {agent.is_enabled ? t.Agents.detail.active : t.Agents.detail.inactive}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="configuration" className="mt-4 space-y-4">
              {/* System Prompt */}
              <div>
                <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.systemPrompt}</h3>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                  {agent.system_prompt}
                </pre>
              </div>

              {/* Rules */}
              {agent.rules && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.rules}</h3>
                  <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                    {agent.rules}
                  </pre>
                </div>
              )}

              {/* Output Format */}
              {agent.output_format && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.outputFormat}</h3>
                  <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                    {agent.output_format}
                  </pre>
                </div>
              )}

              {/* Dynamic Prompt */}
              {agent.dynamic_enabled && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">{t.Agents.detail.dynamicContext}</h3>
                  <div className="text-sm space-y-2">
                    <div>
                      <span className="text-muted-foreground">{t.Agents.detail.enabled}:</span> Yes
                    </div>
                    {agent.dynamic_providers && (
                      <div>
                        <span className="text-muted-foreground">{t.Agents.detail.providers}:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {JSON.parse(agent.dynamic_providers).map((provider: string) => (
                            <Badge key={provider} variant="outline" className="text-xs">
                              {provider}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="tools" className="mt-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-2">
                  {t.Agents.detail.availableTools} ({toolNames.length})
                </h3>
                {toolNames.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t.Agents.detail.noToolsConfigured}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {toolNames.map((toolName) => (
                      <div
                        key={toolName}
                        className="text-xs bg-muted p-2 rounded-md flex items-center gap-2"
                      >
                        <Settings className="h-3 w-3 text-muted-foreground" />
                        <span className="font-mono">{toolName}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </ScrollArea>
        </Tabs>

        <div className="flex gap-2 mt-4 pt-4 border-t">
          {!isSystemAgent && onEdit && (
            <Button onClick={onEdit} variant="default" className="flex-1">
              {t.Agents.detail.editAgent}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={onClose}
            className={!isSystemAgent && onEdit ? '' : 'flex-1'}
          >
            {t.Agents.detail.close}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
