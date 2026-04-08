import { GitLabService } from '../services/gitlabService';

const mockIssueDiscussionsAddNote = jest.fn();
const mockMergeRequestDiscussionsAddNote = jest.fn();
const mockUsersCurrent = jest.fn();

const mockGitlabClient = {
  IssueDiscussions: {
    addNote: mockIssueDiscussionsAddNote,
  },
  MergeRequestDiscussions: {
    addNote: mockMergeRequestDiscussionsAddNote,
  },
  Users: {
    current: mockUsersCurrent,
  },
};

jest.mock('@gitbeaker/node', () => ({
  Gitlab: jest.fn().mockImplementation(() => mockGitlabClient),
}));

jest.mock('../utils/config', () => ({
  config: {
    gitlab: {
      baseUrl: 'https://gitlab.example.com',
      token: 'test-token',
    },
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('GitLabService discussion replies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIssueDiscussionsAddNote.mockResolvedValue({ id: 'discussion-1', notes: [{ id: 11 }] });
    mockMergeRequestDiscussionsAddNote.mockResolvedValue({
      id: 'discussion-2',
      notes: [{ id: 22 }],
    });
    mockUsersCurrent.mockResolvedValue({ id: 1 });
  });

  it('adds an issue discussion reply via gitbeaker', async () => {
    const service = new GitLabService();

    const result = await service.addIssueDiscussionReply(1, 2, 'discussion-1', 'hello issue');

    expect(mockIssueDiscussionsAddNote).toHaveBeenCalledWith(
      1,
      2,
      'discussion-1',
      0,
      'hello issue'
    );
    expect(result).toEqual({ id: 11 });
  });

  it('adds a merge request discussion reply via gitbeaker', async () => {
    const service = new GitLabService();

    const result = await service.addMergeRequestDiscussionReply(1, 27, 'discussion-2', 'hello mr');

    expect(mockMergeRequestDiscussionsAddNote).toHaveBeenCalledWith(
      1,
      27,
      'discussion-2',
      0,
      'hello mr'
    );
    expect(result).toEqual({ id: 22 });
  });

  it('wraps issue discussion reply errors with context', async () => {
    const service = new GitLabService();
    mockIssueDiscussionsAddNote.mockRejectedValueOnce(new Error('boom'));

    await expect(service.addIssueDiscussionReply(1, 2, 'discussion-1', 'hello')).rejects.toThrow(
      'Failed to add issue discussion reply: boom'
    );
  });

  it('wraps merge request discussion reply errors with context', async () => {
    const service = new GitLabService();
    mockMergeRequestDiscussionsAddNote.mockRejectedValueOnce(new Error('boom mr'));

    await expect(
      service.addMergeRequestDiscussionReply(1, 27, 'discussion-2', 'hello')
    ).rejects.toThrow('Failed to add merge request discussion reply: boom mr');
  });
});
