/**
 * Agent Export Service
 *
 * Handles exporting agents to Markdown files with YAML frontmatter,
 * compatible with the existing local import functionality.
 */

import { join } from '@tauri-apps/api/path';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { logger } from '@/lib/logger';
import type { AgentDefinition } from '@/types/agent';

/**
 * Export format for agents - using Markdown with YAML frontmatter
 * to be compatible with existing local import functionality.
 */

/**
 * Export an agent to a Markdown file
 */
export async function exportAgentToFile(agent: AgentDefinition): Promise<boolean> {
  try {
    // Resolve system prompt if it's a function
    let systemPrompt = '';
    if (typeof agent.systemPrompt === 'string') {
      systemPrompt = agent.systemPrompt;
    } else if (typeof agent.systemPrompt === 'function') {
      systemPrompt = await Promise.resolve(agent.systemPrompt());
    }

    // Build YAML frontmatter
    const frontmatterLines: string[] = ['---'];

    // Required fields
    frontmatterLines.push(`name: "${escapeYamlString(agent.name)}"`);

    if (agent.description) {
      frontmatterLines.push(`description: "${escapeYamlString(agent.description)}"`);
    }

    // Model type
    frontmatterLines.push(`model: ${agent.modelType}`);

    // Tools - export as YAML array
    if (agent.tools && Object.keys(agent.tools).length > 0) {
      const toolNames = Object.keys(agent.tools);
      frontmatterLines.push('tools:');
      for (const toolName of toolNames) {
        frontmatterLines.push(`  - ${toolName}`);
      }
    }

    // Optional fields
    if (agent.role) {
      frontmatterLines.push(`role: ${agent.role}`);
    }

    if (agent.canBeSubagent !== undefined) {
      frontmatterLines.push(`canBeSubagent: ${agent.canBeSubagent}`);
    }

    if (agent.version) {
      frontmatterLines.push(`version: "${agent.version}"`);
    }

    // Dynamic prompt config
    if (agent.dynamicPrompt?.enabled) {
      if (agent.dynamicPrompt.providers && agent.dynamicPrompt.providers.length > 0) {
        frontmatterLines.push('dynamicProviders:');
        for (const provider of agent.dynamicPrompt.providers) {
          frontmatterLines.push(`  - ${provider}`);
        }
      }
    }

    frontmatterLines.push('---');
    frontmatterLines.push('');

    // Add system prompt as markdown content
    const markdownContent = frontmatterLines.join('\n') + systemPrompt;

    // Open save dialog
    const filePath = await save({
      defaultPath: `${agent.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`,
      filters: [
        {
          name: 'Markdown',
          extensions: ['md'],
        },
      ],
    });

    if (!filePath) {
      logger.info('Export cancelled by user');
      return false;
    }

    await writeTextFile(filePath, markdownContent);
    logger.info(`Agent exported successfully to ${filePath}`);
    return true;
  } catch (error) {
    logger.error('Failed to export agent:', error);
    throw error;
  }
}

/**
 * Export multiple agents to a directory
 */
export async function exportAgentsToDirectory(agents: AgentDefinition[]): Promise<number> {
  const { open: openDirDialog } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile: writeFile } = await import('@tauri-apps/plugin-fs');

  const dirPath = await openDirDialog({
    directory: true,
    multiple: false,
  });

  if (!dirPath || typeof dirPath !== 'string') {
    logger.info('Export cancelled by user');
    return 0;
  }

  let exportedCount = 0;
  for (const agent of agents) {
    try {
      const fileName = `${agent.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`;
      const filePath = await join(dirPath, fileName);

      // Resolve system prompt if it's a function
      let systemPrompt = '';
      if (typeof agent.systemPrompt === 'string') {
        systemPrompt = agent.systemPrompt;
      } else if (typeof agent.systemPrompt === 'function') {
        systemPrompt = await Promise.resolve(agent.systemPrompt());
      }

      // Build YAML frontmatter
      const frontmatterLines: string[] = ['---'];

      // Required fields
      frontmatterLines.push(`name: "${escapeYamlString(agent.name)}"`);

      if (agent.description) {
        frontmatterLines.push(`description: "${escapeYamlString(agent.description)}"`);
      }

      // Model type
      frontmatterLines.push(`model: ${agent.modelType}`);

      // Tools
      if (agent.tools && Object.keys(agent.tools).length > 0) {
        const toolNames = Object.keys(agent.tools);
        frontmatterLines.push('tools:');
        for (const toolName of toolNames) {
          frontmatterLines.push(`  - ${toolName}`);
        }
      }

      // Optional fields
      if (agent.role) {
        frontmatterLines.push(`role: ${agent.role}`);
      }

      if (agent.canBeSubagent !== undefined) {
        frontmatterLines.push(`canBeSubagent: ${agent.canBeSubagent}`);
      }

      if (agent.version) {
        frontmatterLines.push(`version: "${agent.version}"`);
      }

      frontmatterLines.push('---');
      frontmatterLines.push('');

      // Add system prompt as markdown content
      const markdownContent = frontmatterLines.join('\n') + systemPrompt;

      await writeFile(filePath, markdownContent);
      exportedCount++;
    } catch (error) {
      logger.error(`Failed to export agent ${agent.id}:`, error);
    }
  }

  logger.info(`Exported ${exportedCount} agents to ${dirPath}`);
  return exportedCount;
}

/**
 * Escape special characters in YAML string values
 */
function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
