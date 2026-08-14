import type {
  AgentAttachment,
  AgentDetectionRequest,
  AgentInstallation,
  AgentSessionBundle,
  AgentSessionListRequest,
  AgentSessionRequest,
  AnswerAgentQuestionRequest,
  ArchiveAgentSessionRequest,
  CreateAgentSessionRequest,
  DeclineAgentQuestionRequest,
  DeleteAgentSessionResult,
  RenameAgentSessionRequest,
  ResolveAgentApprovalRequest,
  SendAgentMessageRequest,
  SetAgentSessionConfigOptionRequest,
  UploadAgentAttachmentsRequest,
} from '@cozypad/contracts';
import {
  AgentCommunicationService,
  type AgentCommunicationEvents,
  type AgentCommunicationPort,
} from './agentCommunicationService';
import { isLocalProfile } from './transport/localTransport';
import { RemoteAgentHostClient } from './remoteAgentHostClient';

/** Routes local sessions locally and SSH sessions to the target-owned host. */
export class RoutingAgentCommunication implements AgentCommunicationPort {
  private active: AgentCommunicationPort;

  constructor(
    private readonly local: AgentCommunicationService,
    private readonly remote: RemoteAgentHostClient,
  ) {
    this.active = remote;
  }

  setEvents(events: AgentCommunicationEvents): void {
    this.local.setEvents(events);
    this.remote.setEvents(events);
  }

  async load(): Promise<void> {
    await Promise.all([this.local.load(), this.remote.load()]);
  }

  async connected(profileId: string): Promise<void> {
    if (isLocalProfile(profileId)) {
      this.active = this.local;
      await this.local.connected(profileId);
      return;
    }

    const legacy = this.local.exportHostSessions(profileId);
    this.active = this.remote;
    await this.remote.connected(profileId);
    if (legacy.length > 0) {
      await this.remote.importLegacy(profileId, legacy);
      // The target acknowledged a durable import. Only now remove the former
      // desktop-local shadow so future connections have one canonical owner.
      await this.local.forgetMigratedHostSessions(profileId);
    }
  }

  disconnected(profileId: string): void {
    if (isLocalProfile(profileId)) this.local.disconnected(profileId);
    else this.remote.disconnected(profileId);
  }

  detect(request: AgentDetectionRequest): Promise<AgentInstallation> {
    return this.forProfile(request.profileId).detect(request);
  }

  list(
    request: AgentSessionListRequest,
  ): AgentSessionBundle[] | Promise<AgentSessionBundle[]> {
    return this.forProfile(request.profileId).list(request);
  }

  create(request: CreateAgentSessionRequest): Promise<AgentSessionBundle> {
    return this.forProfile(request.profileId).create(request);
  }

  revive(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    return this.active.revive(request);
  }

  archive(request: ArchiveAgentSessionRequest): Promise<AgentSessionBundle> {
    return this.active.archive(request);
  }

  restore(request: AgentSessionRequest): Promise<AgentSessionBundle> {
    return this.active.restore(request);
  }

  rename(request: RenameAgentSessionRequest): Promise<void> {
    return this.active.rename(request);
  }

  delete(request: AgentSessionRequest): Promise<DeleteAgentSessionResult> {
    return this.active.delete(request);
  }

  uploadAttachments(
    request: UploadAgentAttachmentsRequest,
  ): Promise<AgentAttachment[]> {
    return this.active.uploadAttachments(request);
  }

  send(request: SendAgentMessageRequest): Promise<void> {
    return this.active.send(request);
  }

  interrupt(request: AgentSessionRequest): Promise<void> {
    return this.active.interrupt(request);
  }

  setConfigOption(request: SetAgentSessionConfigOptionRequest): Promise<void> {
    return this.active.setConfigOption(request);
  }

  resolveApproval(request: ResolveAgentApprovalRequest): Promise<void> {
    return this.active.resolveApproval(request);
  }

  answerQuestion(request: AnswerAgentQuestionRequest): Promise<void> {
    return this.active.answerQuestion(request);
  }

  declineQuestion(request: DeclineAgentQuestionRequest): Promise<void> {
    return this.active.declineQuestion(request);
  }

  private forProfile(profileId: string): AgentCommunicationPort {
    return isLocalProfile(profileId) ? this.local : this.remote;
  }
}
