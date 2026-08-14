import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  LoaderCircle,
  RotateCcw,
  Save,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Upload,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import type {
  PromptTemplate,
  PromptTemplateProvider,
  PromptTemplateScope,
  PromptOptimizationProposal,
  ReviewFeedback,
  ReviewPrompt,
  ReviewPromptProvider,
  ReviewSkill,
} from '../types';

const TEMPLATE_PROVIDERS: PromptTemplateProvider[] = ['claude', 'codex', 'review', 'shared'];
const TEMPLATE_SCOPES: PromptTemplateScope[] = [
  'edit',
  'review',
  'context',
  'fallback',
  'pass',
  'scoring',
];
const PROVIDERS: ReviewPromptProvider[] = ['any', 'claude', 'codex', 'coderabbit'];
const FEEDBACK_LABELS: ReviewFeedback['label'][] = [
  'false_positive',
  'missed_issue',
  'unclear',
  'useful',
  'accepted',
  'rejected',
];

function linesToText(lines: string[]): string {
  return lines.join('\n');
}

function textToLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function csvToList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function replaceById<T extends { id: string }>(items: T[], next: T): T[] {
  return items.map(item => (item.id === next.id ? next : item));
}

export default function ReviewTuning() {
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [prompts, setPrompts] = useState<ReviewPrompt[]>([]);
  const [skills, setSkills] = useState<ReviewSkill[]>([]);
  const [feedback, setFeedback] = useState<ReviewFeedback[]>([]);
  const [proposals, setProposals] = useState<PromptOptimizationProposal[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateLabel, setTemplateLabel] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateEnabled, setTemplateEnabled] = useState(true);
  const [templateProvider, setTemplateProvider] = useState<PromptTemplateProvider>('shared');
  const [templateScope, setTemplateScope] = useState<PromptTemplateScope>('context');
  const [templateBody, setTemplateBody] = useState('');
  const [templatePublishNote, setTemplatePublishNote] = useState('');
  const [templateRollbackVersion, setTemplateRollbackVersion] = useState(1);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [promptLabel, setPromptLabel] = useState('');
  const [promptEnabled, setPromptEnabled] = useState(true);
  const [promptFocus, setPromptFocus] = useState('');
  const [promptInstructions, setPromptInstructions] = useState('');
  const [publishNote, setPublishNote] = useState('');
  const [rollbackVersion, setRollbackVersion] = useState(1);
  const [skillDraft, setSkillDraft] = useState({
    name: '',
    description: '',
    provider: 'any' as ReviewPromptProvider,
    fileGlobs: 'src/**',
    languageHints: 'typescript',
    promptIds: 'bug-scan',
    systemInstructions: '',
    priority: 10,
  });
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [skillEdit, setSkillEdit] = useState({
    name: '',
    description: '',
    provider: 'any' as ReviewPromptProvider,
    fileGlobs: '',
    languageHints: '',
    promptIds: '',
    systemInstructions: '',
    priority: 0,
    enabled: true,
  });
  const [feedbackDraft, setFeedbackDraft] = useState({
    promptId: 'bug-scan',
    label: 'false_positive' as ReviewFeedback['label'],
    note: '',
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const selectedTemplate = useMemo(
    () => promptTemplates.find(template => template.id === selectedTemplateId) || null,
    [promptTemplates, selectedTemplateId]
  );

  const selectedPrompt = useMemo(
    () => prompts.find(prompt => prompt.id === selectedPromptId) || null,
    [prompts, selectedPromptId]
  );

  const selectedSkill = useMemo(
    () => skills.find(skill => skill.id === selectedSkillId) || null,
    [skills, selectedSkillId]
  );

  useEffect(() => {
    let active = true;

    Promise.all([
      api.getPromptTemplates(),
      api.getPrompts(),
      api.getSkills(),
      api.getFeedback(),
      api.getProposals(),
    ])
      .then(([templateResult, promptResult, skillResult, feedbackResult, proposalResult]) => {
        if (!active) return;
        setPromptTemplates(templateResult.templates);
        setPrompts(promptResult.prompts);
        setSkills(skillResult.skills);
        setFeedback(feedbackResult.feedback);
        setProposals(proposalResult.proposals);
        setSelectedTemplateId(templateResult.templates[0]?.id || '');
        setSelectedPromptId(promptResult.prompts[0]?.id || '');
        setSelectedSkillId(skillResult.skills[0]?.id || '');
        setFeedbackDraft(current => ({
          ...current,
          promptId:
            promptResult.prompts.find(prompt => prompt.id === 'bug-scan')?.id ||
            promptResult.prompts[0]?.id ||
            '',
        }));
        setError('');
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedTemplate) return;
    setTemplateLabel(selectedTemplate.label);
    setTemplateDescription(selectedTemplate.description);
    setTemplateEnabled(selectedTemplate.enabled);
    setTemplateProvider(selectedTemplate.provider);
    setTemplateScope(selectedTemplate.scope);
    setTemplateBody(selectedTemplate.draft.body);
    setTemplateRollbackVersion(selectedTemplate.currentVersion);
  }, [selectedTemplate]);

  useEffect(() => {
    if (!selectedPrompt) return;
    setPromptLabel(selectedPrompt.label);
    setPromptEnabled(selectedPrompt.enabled);
    setPromptFocus(linesToText(selectedPrompt.draft.focus));
    setPromptInstructions(selectedPrompt.draft.systemInstructions);
    setRollbackVersion(selectedPrompt.currentVersion);
  }, [selectedPrompt]);

  useEffect(() => {
    if (!selectedSkill) return;
    setSkillEdit({
      name: selectedSkill.name,
      description: selectedSkill.description,
      provider: selectedSkill.provider,
      fileGlobs: selectedSkill.fileGlobs.join(', '),
      languageHints: selectedSkill.languageHints.join(', '),
      promptIds: selectedSkill.promptIds.join(', '),
      systemInstructions: selectedSkill.systemInstructions,
      priority: selectedSkill.priority,
      enabled: selectedSkill.enabled,
    });
  }, [selectedSkill]);

  function setNotice(nextMessage: string) {
    setMessage(nextMessage);
    setError('');
  }

  function setFailure(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
    setMessage('');
  }

  async function savePromptTemplate(event: FormEvent) {
    event.preventDefault();
    if (!selectedTemplate) return;
    setBusy('save-template');
    try {
      const result = await api.updatePromptTemplate(selectedTemplate.id, {
        label: templateLabel,
        description: templateDescription,
        enabled: templateEnabled,
        provider: templateProvider,
        scope: templateScope,
        draft: {
          body: templateBody,
        },
      });
      setPromptTemplates(current => replaceById(current, result.template));
      setNotice('Prompt template draft saved.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function publishPromptTemplate() {
    if (!selectedTemplate) return;
    setBusy('publish-template');
    try {
      const result = await api.publishPromptTemplate(selectedTemplate.id, templatePublishNote);
      setPromptTemplates(current => replaceById(current, result.template));
      setTemplatePublishNote('');
      setNotice(`Published ${result.template.label} v${result.template.currentVersion}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function rollbackPromptTemplate() {
    if (!selectedTemplate) return;
    setBusy('rollback-template');
    try {
      const result = await api.rollbackPromptTemplate(
        selectedTemplate.id,
        templateRollbackVersion,
        `Rollback to v${templateRollbackVersion}`
      );
      setPromptTemplates(current => replaceById(current, result.template));
      setNotice(`Rolled template back through v${result.template.currentVersion}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function savePrompt(event: FormEvent) {
    event.preventDefault();
    if (!selectedPrompt) return;
    setBusy('save-prompt');
    try {
      const result = await api.updatePrompt(selectedPrompt.id, {
        label: promptLabel,
        enabled: promptEnabled,
        draft: {
          focus: textToLines(promptFocus),
          systemInstructions: promptInstructions,
        },
      });
      setPrompts(current => replaceById(current, result.prompt));
      setNotice('Prompt draft saved.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function publishPrompt() {
    if (!selectedPrompt) return;
    setBusy('publish-prompt');
    try {
      const result = await api.publishPrompt(selectedPrompt.id, publishNote);
      setPrompts(current => replaceById(current, result.prompt));
      setPublishNote('');
      setNotice(`Published ${result.prompt.label} v${result.prompt.currentVersion}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function rollbackPrompt() {
    if (!selectedPrompt) return;
    setBusy('rollback-prompt');
    try {
      const result = await api.rollbackPrompt(
        selectedPrompt.id,
        rollbackVersion,
        `Rollback to v${rollbackVersion}`
      );
      setPrompts(current => replaceById(current, result.prompt));
      setNotice(`Rolled back through v${result.prompt.currentVersion}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function createSkill(event: FormEvent) {
    event.preventDefault();
    setBusy('create-skill');
    try {
      const result = await api.createSkill({
        name: skillDraft.name,
        description: skillDraft.description,
        provider: skillDraft.provider,
        fileGlobs: csvToList(skillDraft.fileGlobs),
        languageHints: csvToList(skillDraft.languageHints),
        promptIds: csvToList(skillDraft.promptIds),
        systemInstructions: skillDraft.systemInstructions,
        priority: skillDraft.priority,
      });
      setSkills(current => [...current, result.skill]);
      setSkillDraft(current => ({ ...current, name: '', systemInstructions: '' }));
      setNotice('Skill created.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function toggleSkill(skill: ReviewSkill) {
    setBusy(`skill-${skill.id}`);
    try {
      const result = skill.enabled ? await api.disableSkill(skill.id) : await api.enableSkill(skill.id);
      setSkills(current => replaceById(current, result.skill));
      setNotice(`${result.skill.name} ${result.skill.enabled ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function saveSkill(event: FormEvent) {
    event.preventDefault();
    if (!selectedSkill) return;
    setBusy(`save-skill-${selectedSkill.id}`);
    try {
      const result = await api.updateSkill(selectedSkill.id, {
        name: skillEdit.name,
        description: skillEdit.description,
        provider: skillEdit.provider,
        fileGlobs: csvToList(skillEdit.fileGlobs),
        languageHints: csvToList(skillEdit.languageHints),
        promptIds: csvToList(skillEdit.promptIds),
        systemInstructions: skillEdit.systemInstructions,
        priority: skillEdit.priority,
        enabled: skillEdit.enabled,
      });
      setSkills(current => replaceById(current, result.skill));
      setNotice(`Saved ${result.skill.name}.`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function createFeedback(event: FormEvent) {
    event.preventDefault();
    setBusy('create-feedback');
    try {
      const result = await api.createFeedback({
        promptId: feedbackDraft.promptId || undefined,
        label: feedbackDraft.label,
        note: feedbackDraft.note,
        source: 'admin',
      });
      setFeedback(current => [result.feedback, ...current]);
      setFeedbackDraft(current => ({ ...current, note: '' }));
      setNotice('Feedback recorded.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function analyzeFeedback() {
    setBusy('analyze');
    try {
      const result = await api.analyzeFeedback();
      setProposals(current => [...result.proposals, ...current]);
      setNotice(`Generated ${result.proposals.length} proposal(s).`);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function applyProposal(proposal: PromptOptimizationProposal) {
    setBusy(`proposal-${proposal.id}`);
    try {
      const result = await api.applyProposal(proposal.id);
      const prompt = await api.getPrompt(result.proposal.promptId);
      setProposals(current => replaceById(current, result.proposal));
      setPrompts(current => replaceById(current, prompt.prompt));
      setNotice('Proposal applied to draft.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  async function dismissProposal(proposal: PromptOptimizationProposal) {
    setBusy(`dismiss-proposal-${proposal.id}`);
    try {
      const result = await api.dismissProposal(proposal.id);
      setProposals(current => replaceById(current, result.proposal));
      setNotice('Proposal dismissed.');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Review Tuning</h1>
            <p>Loading prompt and skill configuration.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Review Tuning</h1>
          <p>Manage review prompts, skill instructions, feedback, and draft optimization proposals.</p>
        </div>
        <div className="header-actions">
          <button className="button" type="button" onClick={analyzeFeedback} disabled={Boolean(busy)}>
            {busy === 'analyze' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
            Analyze feedback
          </button>
        </div>
      </div>

      {message ? (
        <section className="banner ok">
          <div>
            <strong>Updated</strong>
            <p>{message}</p>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="banner error">
          <div>
            <strong>Request failed</strong>
            <p>{error}</p>
          </div>
        </section>
      ) : null}

      <div className="grid two wide-left">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Prompt Templates</h2>
              <p>Critical execution prompts for ordinary agents, read-only reviews, and review scoring.</p>
            </div>
          </div>
          <div className="prompt-list">
            {promptTemplates.map(template => (
              <button
                key={template.id}
                type="button"
                className={`list-button ${selectedTemplateId === template.id ? 'active' : ''}`}
                onClick={() => setSelectedTemplateId(template.id)}
              >
                <span>
                  <strong>{template.label}</strong>
                  <small className="mono">{template.id}</small>
                </span>
                <span className={`status-chip ${template.enabled ? 'ok' : 'neutral'}`}>
                  {template.provider} / v{template.currentVersion}
                </span>
              </button>
            ))}
          </div>
        </section>

        <form className="panel" onSubmit={savePromptTemplate}>
          <div className="panel-header">
            <div>
              <h2>{selectedTemplate?.label || 'Template editor'}</h2>
              <p>{selectedTemplate?.description || 'Select a prompt template to edit.'}</p>
            </div>
            <span className={`status-chip ${templateEnabled ? 'ok' : 'neutral'}`}>
              {templateEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          {selectedTemplate ? (
            <>
              <div className="field-grid two">
                <div className="field">
                  <label htmlFor="template-label">Label</label>
                  <input
                    id="template-label"
                    value={templateLabel}
                    onChange={event => setTemplateLabel(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="template-enabled">Enabled</label>
                  <select
                    id="template-enabled"
                    value={templateEnabled ? 'true' : 'false'}
                    onChange={event => setTemplateEnabled(event.target.value === 'true')}
                  >
                    <option value="true">enabled</option>
                    <option value="false">disabled</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="template-provider">Provider</label>
                  <select
                    id="template-provider"
                    value={templateProvider}
                    onChange={event => setTemplateProvider(event.target.value as PromptTemplateProvider)}
                  >
                    {TEMPLATE_PROVIDERS.map(provider => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="template-scope">Scope</label>
                  <select
                    id="template-scope"
                    value={templateScope}
                    onChange={event => setTemplateScope(event.target.value as PromptTemplateScope)}
                  >
                    {TEMPLATE_SCOPES.map(scope => (
                      <option key={scope} value={scope}>
                        {scope}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="template-description">Description</label>
                <input
                  id="template-description"
                  value={templateDescription}
                  onChange={event => setTemplateDescription(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="template-body">Draft body</label>
                <textarea
                  id="template-body"
                  className="tall code-area"
                  value={templateBody}
                  onChange={event => setTemplateBody(event.target.value)}
                />
                <div className="field-meta mono">Tokens use double braces, for example {'{{command}}'}.</div>
              </div>
              <details className="details-box">
                <summary>Built-in default</summary>
                <pre>{selectedTemplate.defaultBody}</pre>
              </details>
              <div className="button-row">
                <button className="button primary" type="submit" disabled={Boolean(busy)}>
                  {busy === 'save-template' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                  Save draft
                </button>
                <input
                  aria-label="Template publish note"
                  className="inline-input"
                  value={templatePublishNote}
                  onChange={event => setTemplatePublishNote(event.target.value)}
                  placeholder="Publish note"
                />
                <button className="button" type="button" onClick={publishPromptTemplate} disabled={Boolean(busy)}>
                  <Upload size={16} />
                  Publish
                </button>
                <select
                  className="inline-select"
                  value={templateRollbackVersion}
                  onChange={event => setTemplateRollbackVersion(Number.parseInt(event.target.value, 10))}
                  aria-label="Template rollback version"
                >
                  {selectedTemplate.versions.map(version => (
                    <option key={version.version} value={version.version}>
                      v{version.version}
                    </option>
                  ))}
                </select>
                <button className="button subtle" type="button" onClick={rollbackPromptTemplate} disabled={Boolean(busy)}>
                  <RotateCcw size={16} />
                  Rollback
                </button>
              </div>
            </>
          ) : null}
        </form>
      </div>

      <div className="grid two wide-left">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Prompts</h2>
              <p>Published versions are used by new review runs; draft edits stay local until published.</p>
            </div>
          </div>
          <div className="prompt-list">
            {prompts.map(prompt => (
              <button
                key={prompt.id}
                type="button"
                className={`list-button ${selectedPromptId === prompt.id ? 'active' : ''}`}
                onClick={() => setSelectedPromptId(prompt.id)}
              >
                <span>
                  <strong>{prompt.label}</strong>
                  <small className="mono">{prompt.id}</small>
                </span>
                <span className={`status-chip ${prompt.enabled ? 'ok' : 'neutral'}`}>
                  v{prompt.currentVersion}
                </span>
              </button>
            ))}
          </div>
        </section>

        <form className="panel" onSubmit={savePrompt}>
          <div className="panel-header">
            <div>
              <h2>{selectedPrompt?.label || 'Prompt editor'}</h2>
              <p>{selectedPrompt?.description || 'Select a prompt to edit.'}</p>
            </div>
            <span className={`status-chip ${promptEnabled ? 'ok' : 'neutral'}`}>
              {promptEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          {selectedPrompt ? (
            <>
              <div className="field-grid two">
                <div className="field">
                  <label htmlFor="prompt-label">Label</label>
                  <input
                    id="prompt-label"
                    value={promptLabel}
                    onChange={event => setPromptLabel(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="prompt-enabled">Enabled</label>
                  <select
                    id="prompt-enabled"
                    value={promptEnabled ? 'true' : 'false'}
                    onChange={event => setPromptEnabled(event.target.value === 'true')}
                  >
                    <option value="true">enabled</option>
                    <option value="false">disabled</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="prompt-focus">Focus lines</label>
                <textarea
                  id="prompt-focus"
                  className="tall"
                  value={promptFocus}
                  onChange={event => setPromptFocus(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="prompt-instructions">System instructions</label>
                <textarea
                  id="prompt-instructions"
                  value={promptInstructions}
                  onChange={event => setPromptInstructions(event.target.value)}
                />
              </div>
              <div className="button-row">
                <button className="button primary" type="submit" disabled={Boolean(busy)}>
                  {busy === 'save-prompt' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                  Save draft
                </button>
                <input
                  aria-label="Publish note"
                  className="inline-input"
                  value={publishNote}
                  onChange={event => setPublishNote(event.target.value)}
                  placeholder="Publish note"
                />
                <button className="button" type="button" onClick={publishPrompt} disabled={Boolean(busy)}>
                  <Upload size={16} />
                  Publish
                </button>
                <select
                  className="inline-select"
                  value={rollbackVersion}
                  onChange={event => setRollbackVersion(Number.parseInt(event.target.value, 10))}
                  aria-label="Rollback version"
                >
                  {selectedPrompt.versions.map(version => (
                    <option key={version.version} value={version.version}>
                      v{version.version}
                    </option>
                  ))}
                </select>
                <button className="button subtle" type="button" onClick={rollbackPrompt} disabled={Boolean(busy)}>
                  <RotateCcw size={16} />
                  Rollback
                </button>
              </div>
            </>
          ) : null}
        </form>
      </div>

      <div className="grid two">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Skills</h2>
              <p>Instruction bundles matched by provider, changed files, and prompt IDs.</p>
            </div>
          </div>
          <form className="field-grid" onSubmit={createSkill}>
            <div className="field-grid two">
              <div className="field">
                <label htmlFor="skill-name">Name</label>
                <input
                  id="skill-name"
                  value={skillDraft.name}
                  onChange={event => setSkillDraft(current => ({ ...current, name: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="skill-provider">Provider</label>
                <select
                  id="skill-provider"
                  value={skillDraft.provider}
                  onChange={event =>
                    setSkillDraft(current => ({
                      ...current,
                      provider: event.target.value as ReviewPromptProvider,
                    }))
                  }
                >
                  {PROVIDERS.map(provider => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="skill-globs">File globs</label>
                <input
                  id="skill-globs"
                  value={skillDraft.fileGlobs}
                  onChange={event => setSkillDraft(current => ({ ...current, fileGlobs: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="skill-prompts">Prompt IDs</label>
                <input
                  id="skill-prompts"
                  value={skillDraft.promptIds}
                  onChange={event => setSkillDraft(current => ({ ...current, promptIds: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="skill-languages">Language hints</label>
                <input
                  id="skill-languages"
                  value={skillDraft.languageHints}
                  onChange={event => setSkillDraft(current => ({ ...current, languageHints: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="skill-priority">Priority</label>
                <input
                  id="skill-priority"
                  type="number"
                  value={skillDraft.priority}
                  onChange={event =>
                    setSkillDraft(current => ({
                      ...current,
                      priority: Number.parseInt(event.target.value, 10) || 0,
                    }))
                  }
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="skill-description">Description</label>
              <input
                id="skill-description"
                value={skillDraft.description}
                onChange={event => setSkillDraft(current => ({ ...current, description: event.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="skill-instructions">Instructions</label>
              <textarea
                id="skill-instructions"
                value={skillDraft.systemInstructions}
                onChange={event =>
                  setSkillDraft(current => ({ ...current, systemInstructions: event.target.value }))
                }
              />
            </div>
            <button className="button primary" type="submit" disabled={Boolean(busy)}>
              {busy === 'create-skill' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              Create skill
            </button>
          </form>
          <div className="compact-list">
            {skills.map(skill => (
              <div className="list-row" key={skill.id}>
                <div>
                  <strong>{skill.name}</strong>
                  <div className="field-meta mono">
                    {skill.provider} / {skill.fileGlobs.join(', ') || 'all files'} / {skill.promptIds.join(', ') || 'all prompts'}
                  </div>
                </div>
                <div className="button-row">
                  <button className="button subtle" type="button" onClick={() => setSelectedSkillId(skill.id)}>
                    Edit
                  </button>
                  <button className="button subtle" type="button" onClick={() => toggleSkill(skill)} disabled={Boolean(busy)}>
                    {skill.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                    {skill.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {selectedSkill ? (
            <form className="field-grid skill-editor" onSubmit={saveSkill}>
              <div className="panel-header compact">
                <div>
                  <h2>Edit Skill</h2>
                  <p className="mono">{selectedSkill.id}</p>
                </div>
                <span className={`status-chip ${skillEdit.enabled ? 'ok' : 'neutral'}`}>
                  {skillEdit.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="field-grid two">
                <div className="field">
                  <label htmlFor="edit-skill-name">Name</label>
                  <input
                    id="edit-skill-name"
                    value={skillEdit.name}
                    onChange={event => setSkillEdit(current => ({ ...current, name: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="edit-skill-enabled">Enabled</label>
                  <select
                    id="edit-skill-enabled"
                    value={skillEdit.enabled ? 'true' : 'false'}
                    onChange={event => setSkillEdit(current => ({ ...current, enabled: event.target.value === 'true' }))}
                  >
                    <option value="true">enabled</option>
                    <option value="false">disabled</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="edit-skill-provider">Provider</label>
                  <select
                    id="edit-skill-provider"
                    value={skillEdit.provider}
                    onChange={event =>
                      setSkillEdit(current => ({
                        ...current,
                        provider: event.target.value as ReviewPromptProvider,
                      }))
                    }
                  >
                    {PROVIDERS.map(provider => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="edit-skill-priority">Priority</label>
                  <input
                    id="edit-skill-priority"
                    type="number"
                    value={skillEdit.priority}
                    onChange={event =>
                      setSkillEdit(current => ({
                        ...current,
                        priority: Number.parseInt(event.target.value, 10) || 0,
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="edit-skill-globs">File globs</label>
                  <input
                    id="edit-skill-globs"
                    value={skillEdit.fileGlobs}
                    onChange={event => setSkillEdit(current => ({ ...current, fileGlobs: event.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="edit-skill-prompts">Prompt IDs</label>
                  <input
                    id="edit-skill-prompts"
                    value={skillEdit.promptIds}
                    onChange={event => setSkillEdit(current => ({ ...current, promptIds: event.target.value }))}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="edit-skill-languages">Language hints</label>
                <input
                  id="edit-skill-languages"
                  value={skillEdit.languageHints}
                  onChange={event => setSkillEdit(current => ({ ...current, languageHints: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-skill-description">Description</label>
                <input
                  id="edit-skill-description"
                  value={skillEdit.description}
                  onChange={event => setSkillEdit(current => ({ ...current, description: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-skill-instructions">Instructions</label>
                <textarea
                  id="edit-skill-instructions"
                  value={skillEdit.systemInstructions}
                  onChange={event => setSkillEdit(current => ({ ...current, systemInstructions: event.target.value }))}
                />
              </div>
              <button className="button primary" type="submit" disabled={Boolean(busy)}>
                {busy === `save-skill-${selectedSkill.id}` ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
                Save skill
              </button>
            </form>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Feedback and proposals</h2>
              <p>Feedback produces proposals that update prompt drafts only after review.</p>
            </div>
          </div>
          <form className="field-grid" onSubmit={createFeedback}>
            <div className="field-grid two">
              <div className="field">
                <label htmlFor="feedback-prompt">Prompt</label>
                <select
                  id="feedback-prompt"
                  value={feedbackDraft.promptId}
                  onChange={event => setFeedbackDraft(current => ({ ...current, promptId: event.target.value }))}
                >
                  {prompts.map(prompt => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="feedback-label">Label</label>
                <select
                  id="feedback-label"
                  value={feedbackDraft.label}
                  onChange={event =>
                    setFeedbackDraft(current => ({
                      ...current,
                      label: event.target.value as ReviewFeedback['label'],
                    }))
                  }
                >
                  {FEEDBACK_LABELS.map(label => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="feedback-note">Note</label>
              <textarea
                id="feedback-note"
                value={feedbackDraft.note}
                onChange={event => setFeedbackDraft(current => ({ ...current, note: event.target.value }))}
              />
            </div>
            <button className="button primary" type="submit" disabled={Boolean(busy)}>
              {busy === 'create-feedback' ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}
              Record feedback
            </button>
          </form>

          <div className="compact-list">
            {proposals.map(proposal => (
              <div className="list-row align-start" key={proposal.id}>
                <div>
                  <strong>{proposal.title}</strong>
                  <div className="field-meta">{proposal.rationale}</div>
                  <div className="field-meta mono">
                    {proposal.promptId} / base v{proposal.baseVersion} / {proposal.status}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="button subtle"
                    type="button"
                    onClick={() => applyProposal(proposal)}
                    disabled={Boolean(busy) || proposal.status !== 'open'}
                  >
                    {busy === `proposal-${proposal.id}` ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                    Apply
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Dismiss proposal"
                    aria-label="Dismiss proposal"
                    onClick={() => dismissProposal(proposal)}
                    disabled={Boolean(busy) || proposal.status !== 'open'}
                  >
                    <XCircle size={16} />
                  </button>
                </div>
              </div>
            ))}
            {feedback.slice(0, 5).map(item => (
              <div className="list-row" key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <div className="field-meta">{item.note || 'No note'}</div>
                </div>
                <span className="status-chip neutral">{item.promptId || 'global'}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
