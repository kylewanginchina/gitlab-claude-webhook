import { EventProcessor } from '../services/eventProcessor';
import type { GitLabWebhookEvent } from '../types/gitlab';

const mockPrepareProject = jest.fn();
const mockCleanup = jest.fn();
const mockCreateIssueComment = jest.fn();
const mockCreateMergeRequestComment = jest.fn();
const mockAddIssueComment = jest.fn();
const mockAddMergeRequestComment = jest.fn();
const mockUpdateIssueComment = jest.fn();
const mockUpdateMergeRequestComment = jest.fn();
const mockAddIssueDiscussionReply = jest.fn();
const mockAddMergeRequestDiscussionReply = jest.fn();
const mockGetIssueDiscussions = jest.fn();
const mockGetMergeRequestDiscussions = jest.fn();
const mockFindNoteInDiscussions = jest.fn();
const mockExecuteClaude = jest.fn();
const mockExecuteCodex = jest.fn();

jest.mock('../services/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    prepareProject: mockPrepareProject,
    cleanup: mockCleanup,
  })),
}));

jest.mock('../services/gitlabService', () => ({
  GitLabService: jest.fn().mockImplementation(() => ({
    createIssueComment: mockCreateIssueComment,
    createMergeRequestComment: mockCreateMergeRequestComment,
    addIssueComment: mockAddIssueComment,
    addMergeRequestComment: mockAddMergeRequestComment,
    updateIssueComment: mockUpdateIssueComment,
    updateMergeRequestComment: mockUpdateMergeRequestComment,
    addIssueDiscussionReply: mockAddIssueDiscussionReply,
    addMergeRequestDiscussionReply: mockAddMergeRequestDiscussionReply,
    getIssueDiscussions: mockGetIssueDiscussions,
    getMergeRequestDiscussions: mockGetMergeRequestDiscussions,
    findNoteInDiscussions: mockFindNoteInDiscussions,
  })),
}));

jest.mock('../services/streamingClaudeExecutor', () => ({
  StreamingClaudeExecutor: jest.fn().mockImplementation(() => ({
    executeWithStreaming: mockExecuteClaude,
  })),
}));

jest.mock('../services/codexExecutor', () => ({
  CodexExecutor: jest.fn().mockImplementation(() => ({
    executeWithStreaming: mockExecuteCodex,
  })),
}));

function buildIssueEvent(command: string, issueIid: number): GitLabWebhookEvent {
  return {
    object_kind: 'issue',
    user: { id: 1, name: 'Tester', username: 'tester' },
    project: {
      id: 1,
      default_branch: 'main',
      web_url: 'https://example.com/project',
    },
    issue: {
      iid: issueIid,
      title: `Issue ${issueIid}`,
      description: `@claude ${command}`,
    },
  } as unknown as GitLabWebhookEvent;
}

function buildMergeRequestNoteEvent(): GitLabWebhookEvent {
  return {
    object_kind: 'note',
    user: { id: 1, name: 'Tester', username: 'tester' },
    project: {
      id: 1,
      default_branch: 'main',
      web_url: 'https://example.com/project',
    },
    object_attributes: {
      id: 123,
      note: '@claude review this',
    },
    merge_request: {
      iid: 27,
      title: 'MR 27',
      description: 'desc',
      source_branch: 'feature',
      target_branch: 'main',
    },
  } as unknown as GitLabWebhookEvent;
}

describe('EventProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareProject.mockResolvedValue('/tmp/project');
    mockCleanup.mockResolvedValue(undefined);
    mockCreateIssueComment
      .mockResolvedValueOnce({ id: 101 })
      .mockResolvedValueOnce({ id: 202 })
      .mockResolvedValueOnce({ id: 303 })
      .mockResolvedValue({ id: 304 });
    mockCreateMergeRequestComment.mockResolvedValue({ id: 404 });
    mockAddIssueComment.mockResolvedValue(undefined);
    mockAddMergeRequestComment.mockResolvedValue(undefined);
    mockUpdateIssueComment.mockResolvedValue(undefined);
    mockUpdateMergeRequestComment.mockResolvedValue(undefined);
    mockAddIssueDiscussionReply.mockResolvedValue({ id: 501 });
    mockAddMergeRequestDiscussionReply.mockResolvedValue({ id: 502 });
    mockGetIssueDiscussions.mockResolvedValue([]);
    mockGetMergeRequestDiscussions.mockResolvedValue([]);
    mockFindNoteInDiscussions.mockResolvedValue(null);
    mockExecuteCodex.mockResolvedValue({ success: true, output: 'done', changes: [] });
    mockExecuteClaude.mockImplementation(
      async (command: string, _projectPath: string, _ctx: unknown, callback: any) => {
        if (command === 'task-one') {
          await callback.onProgress('progress task-one', false);
          await new Promise(resolve => setTimeout(resolve, 20));
          await callback.onProgress('complete task-one', true);
        } else {
          await new Promise(resolve => setTimeout(resolve, 5));
          await callback.onProgress('progress task-two', false);
          await callback.onProgress('complete task-two', true);
        }
        return { success: true, output: `done ${command}`, changes: [] };
      }
    );
  });

  it('isolates progress state across concurrent requests', async () => {
    const processor = new EventProcessor();

    await Promise.all([
      processor.processEvent(buildIssueEvent('task-one', 1)),
      processor.processEvent(buildIssueEvent('task-two', 2)),
    ]);

    const callsFor101 = mockUpdateIssueComment.mock.calls.filter(call => call[2] === 101);
    const callsFor202 = mockUpdateIssueComment.mock.calls.filter(call => call[2] === 202);

    expect(callsFor101.length).toBeGreaterThan(0);
    expect(callsFor202.length).toBeGreaterThan(0);

    const body101 = callsFor101[callsFor101.length - 1][3];
    const body202 = callsFor202[callsFor202.length - 1][3];

    expect(body101).toContain('task-one');
    expect(body101).not.toContain('task-two');
    expect(body202).toContain('task-two');
    expect(body202).not.toContain('task-one');
  });

  it('uses merge request reply path for merge request notes before fallback', async () => {
    const processor = new EventProcessor();
    const event = buildMergeRequestNoteEvent();
    const context = {
      commentId: null,
      discussionId: 'discussion-1',
      progressMessages: [],
    };

    mockAddMergeRequestDiscussionReply.mockRejectedValue(
      new Error('Discussion reply not implemented')
    );

    await (processor as any).postComment(event, 'hello', context);
    expect(mockAddMergeRequestDiscussionReply).toHaveBeenCalledWith(1, 27, 'discussion-1', 'hello');
    expect(mockAddMergeRequestComment).toHaveBeenCalledWith(1, 27, 'hello');

    const commentId = await (processor as any).createProgressComment(event, 'progress', context);
    expect(mockAddMergeRequestDiscussionReply).toHaveBeenCalledWith(
      1,
      27,
      'discussion-1',
      'progress'
    );
    expect(mockCreateMergeRequestComment).toHaveBeenCalledWith(1, 27, 'progress');
    expect(commentId).toBe(404);
  });

  it('caps progress messages to the latest 10 entries', async () => {
    const processor = new EventProcessor();
    const context = {
      commentId: 101,
      discussionId: null,
      progressMessages: [],
    };
    const event = buildIssueEvent('task-one', 1);

    for (let i = 0; i < 12; i += 1) {
      await (processor as any).updateProgressComment(event, `message-${i}`, context, false, false);
    }

    expect(context.progressMessages).toHaveLength(10);
    expect(context.progressMessages[0]).toContain('message-2');
    expect(context.progressMessages[9]).toContain('message-11');
  });

  it('falls back to creating a new comment when progress update fails', async () => {
    const processor = new EventProcessor();
    const event = buildIssueEvent('task-one', 1);
    const context = {
      commentId: 101,
      discussionId: null,
      progressMessages: [],
    };

    mockUpdateIssueComment.mockRejectedValueOnce(new Error('update failed'));

    await (processor as any).updateProgressComment(
      event,
      'progress task-one',
      context,
      false,
      false
    );

    expect(mockAddIssueComment).toHaveBeenCalledWith(
      1,
      1,
      expect.stringContaining('**Updated Progress:**')
    );
  });
});
