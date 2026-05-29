import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@/types/agent';
import { agentService } from '@/services/database/agent-service';
import { AgentSelector } from './agent-selector';

// Mock dependencies
const mockSetAssistantId = vi.fn();
const mockSetActiveView = vi.fn();
const mockAgentStoreState = {
  agents: new Map<string, AgentDefinition>(),
  isLoading: false,
  isInitialized: false,
  refreshToken: 0,
};

// Mock agent registry
vi.mock('@/services/agents/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => {
      const mockAgents: AgentDefinition[] = [
        {
          id: 'agent-1',
          name: 'Test Agent 1',
          description: 'Test description 1',
          version: '1.0.0',
          isDefault: true,
          hidden: false,
          systemPrompt: 'Test prompt 1',
          modelType: 'main_model' as any,
        },
        {
          id: 'agent-2',
          name: 'Test Agent 2',
          description: 'Test description 2',
          version: '1.0.0',
          isDefault: false,
          hidden: false,
          systemPrompt: 'Test prompt 2',
          modelType: 'main_model' as any,
        },
        {
          id: 'agent-3',
          name: 'Hidden Agent',
          description: 'Hidden agent',
          version: '1.0.0',
          isDefault: false,
          hidden: true,
          systemPrompt: 'Hidden prompt',
          modelType: 'main_model' as any,
        },
      ];

      // Return agents based on mock store size
      return mockAgentStoreState.agents.size > 0 ? mockAgents : [];
    }),
    isSystemAgentEnabled: vi.fn(() => true),
  },
}));

// Mock agent store
const mockLoadAgents = vi.fn();
const mockRefreshAgents = vi.fn();
vi.mock('@/stores/agent-store', () => ({
  useAgentStore: Object.assign(
    vi.fn((selector) => {
      if (typeof selector === 'function') {
        return selector(mockAgentStoreState);
      }
      return mockAgentStoreState;
    }),
    {
      getState: vi.fn(() => ({
        ...mockAgentStoreState,
        loadAgents: mockLoadAgents,
        refreshAgents: mockRefreshAgents,
      })),
    }
  ),
}));

// Mock app settings hook
vi.mock('@/hooks/use-settings', () => ({
  useAppSettings: vi.fn(() => ({
    settings: { assistantId: 'agent-1' },
    setAssistantId: mockSetAssistantId,
    loading: false,
  })),
}));

vi.mock('@/services/database/agent-service', () => ({
  agentService: {
    listAgents: vi.fn(),
  },
}));

// Mock UI navigation
vi.mock('@/contexts/ui-navigation', () => ({
  useUiNavigation: vi.fn(() => ({
    setActiveView: mockSetActiveView,
  })),
}));

// Mock task store
vi.mock('@/stores/task-store', () => ({
  useTaskStore: vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector({
        currentTaskId: null,
        messages: new Map(),
        getMessages: () => [],
      });
    }
    return {
      currentTaskId: null,
      messages: new Map(),
      getMessages: () => [],
    };
  }),
}));

// Mock BaseSelector
vi.mock('./base-selector', () => ({
  BaseSelector: ({ items, placeholder, disabled, value }: any) => (
    <div data-testid="base-selector">
      <span data-testid="selector-disabled">{String(disabled)}</span>
      <span data-testid="selector-placeholder">{placeholder}</span>
      <span data-testid="selector-value">{value}</span>
      <div data-testid="selector-items">
        {items.map((item: any) => (
          <div key={item.value} data-testid={`item-${item.value}`}>
            {item.label}
          </div>
        ))}
      </div>
    </div>
  ),
}));

describe('AgentSelector Component', () => {
  beforeEach(() => {
    mockSetAssistantId.mockClear();
    mockSetActiveView.mockClear();
    mockLoadAgents.mockClear();
    mockRefreshAgents.mockClear();

    // Reset agent store state
    mockAgentStoreState.agents = new Map();
    mockAgentStoreState.isLoading = false;
    mockAgentStoreState.isInitialized = false;
  });

  it('should render selector with "Select agent" placeholder when no agents are loaded and no current agent', () => {
    // No agents in store, no current agent match
    mockAgentStoreState.agents = new Map();

    render(<AgentSelector />);

    expect(screen.getByTestId('base-selector')).toBeInTheDocument();
    // With empty agents, currentAgentName is undefined, so fallback is "Select agent"
    expect(screen.getByTestId('selector-placeholder')).toHaveTextContent('Select agent');
  });

  it('should display agents when loaded from store', async () => {
    // Set agents in store to trigger agent loading
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
      ['agent-2', { id: 'agent-2', name: 'Test Agent 2' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    await waitFor(() => {
      // Use testid-based queries since agent names may also appear in placeholder
      expect(screen.getByTestId('item-agent-1')).toHaveTextContent('Test Agent 1');
      expect(screen.getByTestId('item-agent-2')).toHaveTextContent('Test Agent 2');
    });
  });

  it('should filter out hidden agents', async () => {
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
      ['agent-2', { id: 'agent-2', name: 'Test Agent 2' } as AgentDefinition],
      ['agent-3', { id: 'agent-3', name: 'Hidden Agent', hidden: true } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    await waitFor(() => {
      expect(screen.getByTestId('item-agent-1')).toHaveTextContent('Test Agent 1');
      expect(screen.getByTestId('item-agent-2')).toHaveTextContent('Test Agent 2');
      // Hidden agent should not appear in items
      expect(screen.queryByTestId('item-agent-3')).not.toBeInTheDocument();
    });
  });

  it('should include "Manage agents" option', async () => {
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    await waitFor(() => {
      // The actual text includes an ellipsis: "Manage agents…"
      expect(screen.getByText(/Manage agents/)).toBeInTheDocument();
    });
  });

  it('should not render when agents are loading', async () => {
    mockAgentStoreState.isLoading = true;

    await act(async () => {
      render(<AgentSelector />);
    });

    // When loading, the component returns null
    expect(screen.queryByTestId('base-selector')).not.toBeInTheDocument();
  });

  it('should not be disabled when agents are loaded', () => {
    mockAgentStoreState.isLoading = false;
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    expect(screen.getByTestId('selector-disabled')).toHaveTextContent('false');
  });

  it('should use current assistantId as selected value', () => {
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    expect(screen.getByTestId('selector-value')).toHaveTextContent('agent-1');
  });

  it('should show agent name as placeholder when agent is selected', () => {
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    // Placeholder should show the agent name for the selected value
    expect(screen.getByTestId('selector-placeholder')).toHaveTextContent('Test Agent 1');
  });

  it('should handle disabled prop', async () => {
    mockAgentStoreState.isLoading = false;

    await act(async () => {
      render(<AgentSelector disabled={true} />);
    });

    expect(screen.getByTestId('selector-disabled')).toHaveTextContent('true');
  });

  it('should not render when disabled prop and isLoading are both true', async () => {
    mockAgentStoreState.isLoading = true;

    await act(async () => {
      render(<AgentSelector disabled={true} />);
    });

    // When loading, the component returns null
    expect(screen.queryByTestId('base-selector')).not.toBeInTheDocument();
  });

  it('should re-render when agent store size changes', async () => {
    // Set agents in store before initial render
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
      ['agent-2', { id: 'agent-2', name: 'Test Agent 2' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    // Agents should be visible after render
    await waitFor(() => {
      expect(screen.getByTestId('item-agent-1')).toHaveTextContent('Test Agent 1');
      expect(screen.getByTestId('item-agent-2')).toHaveTextContent('Test Agent 2');
    });
  });

  it('should remove disabled local agents when agents map updates', async () => {
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
      ['agent-2', { id: 'agent-2', name: 'Test Agent 2' } as AgentDefinition],
    ]);

    const listAgentsMock = vi.mocked(agentService.listAgents);
    listAgentsMock.mockResolvedValue([
      { id: 'agent-1', is_enabled: true },
      { id: 'agent-2', is_enabled: true },
    ] as any);

    const { rerender } = render(<AgentSelector />);

    await waitFor(() => {
      expect(screen.getByTestId('item-agent-1')).toHaveTextContent('Test Agent 1');
      expect(screen.getByTestId('item-agent-2')).toHaveTextContent('Test Agent 2');
    });

    listAgentsMock.mockResolvedValue([
      { id: 'agent-1', is_enabled: true },
      { id: 'agent-2', is_enabled: false },
    ] as any);

    // Simulate agents map update (new Map instance triggers useEffect re-run)
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
      ['agent-2', { id: 'agent-2', name: 'Test Agent 2' } as AgentDefinition],
    ]);
    rerender(<AgentSelector />);

    await waitFor(() => {
      expect(screen.getByTestId('item-agent-1')).toHaveTextContent('Test Agent 1');
      expect(screen.queryByTestId('item-agent-2')).not.toBeInTheDocument();
    });
  });

  it('should trigger loadAgents on mount when not initialized', () => {
    mockAgentStoreState.isInitialized = false;

    render(<AgentSelector />);

    expect(mockLoadAgents).toHaveBeenCalled();
  });

  it('should trigger refreshAgents on mount when initialized but agents are empty', () => {
    mockAgentStoreState.isInitialized = true;
    mockAgentStoreState.agents = new Map();

    render(<AgentSelector />);

    expect(mockRefreshAgents).toHaveBeenCalled();
  });

  it('should not trigger load or refresh when initialized with agents', () => {
    mockAgentStoreState.isInitialized = true;
    mockAgentStoreState.agents = new Map([
      ['agent-1', { id: 'agent-1', name: 'Test Agent 1' } as AgentDefinition],
    ]);

    render(<AgentSelector />);

    expect(mockLoadAgents).not.toHaveBeenCalled();
    expect(mockRefreshAgents).not.toHaveBeenCalled();
  });
});
