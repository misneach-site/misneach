import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Resend } from 'resend';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from './entities/User';
import { MagicLinkEmailQueue } from './magic-link-email-queue';
import { MagicLinkTokenStore } from './magic-link-token-store';
import { AuthenticatedRequest } from './types/request';

type AppBrand = {
  name: string;
  tagline: string;
};

type EmailTranslations = {
  subject: string;
  greeting: string;
  intro: string;
  button: string;
  note: string;
  footer: string;
};

const appBrands: Record<'cleachtadh' | 'misneach', AppBrand> = {
  cleachtadh: {
    name: 'Cleachtadh',
    tagline: 'Daily Irish practice',
  },
  misneach: {
    name: 'Misneach',
    tagline: 'Confidence through language',
  },
};

// TODO: Read these from the i18n service
const translations = {
  en: (brand: AppBrand): EmailTranslations => ({
    subject: `Your ${brand.name} Magic Login Link`,
    greeting: `Welcome to ${brand.name}!`,
    intro: 'Click the button below to access your account securely.',
    button: 'Login Now',
    note: 'If you didn’t request this link, you can safely ignore this email.',
    footer: `© 2025 ${brand.name}. All rights reserved.`,
  }),
  ga: (brand: AppBrand): EmailTranslations => ({
    subject: `Do Nasc Draíochta Logála Isteach ${brand.name}`,
    greeting: `Fáilte go ${brand.name}!`,
    intro: 'Cliceáil an cnaipe thíos chun rochtain shlán a fháil ar do chuntas.',
    button: 'Logáil Isteach Anois',
    note: 'Mura ndearna tú iarratas ar an nasc seo, is féidir leat neamhaird a dhéanamh de.',
    footer: `© 2025 ${brand.name}. Gach ceart ar cosaint.`,
  }),
  pt: (brand: AppBrand): EmailTranslations => ({
    subject: `Seu Link Mágico de Login do ${brand.name}`,
    greeting: `Bem-vindo ao ${brand.name}!`,
    intro: 'Clique no botão abaixo para acessar sua conta com segurança.',
    button: 'Entrar Agora',
    note: 'Se você não solicitou este link, pode ignorar este e-mail com segurança.',
    footer: `© 2025 ${brand.name}. Todos os direitos reservados.`,
  }),
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private resend;
  private readonly accessTokenTtlSec = 15 * 60;
  private readonly refreshTokenTtlSec = 30 * 24 * 60 * 60;
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    private readonly config: ConfigService,
    private readonly magicLinkTokenStore: MagicLinkTokenStore,
    private readonly magicLinkEmailQueue: MagicLinkEmailQueue,
  ) {
    this.resend = new Resend(this.config.get<string>('RESEND_API_KEY'));
  }

  toPublicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      clientId: user.clientId,
      role: user.role,
      signupComplete: user.hasCompletedSignup,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      dailyReminderEnabled: user.dailyReminderEnabled,
      dailyReminderTime: user.dailyReminderTime,
      createdAt: user.createdAt,
    };
  }

  private getTokenSecret(): string {
    return (
      this.config.get<string>('AUTH_TOKEN_SECRET') ||
      this.config.get<string>('SESSION_SECRET') ||
      'dev-insecure-auth-token-secret'
    );
  }

  private base64UrlEncode(input: Buffer | string): string {
    const value = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input).toString('base64');
    return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private base64UrlDecode(input: string): string {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const headerEncoded = this.base64UrlEncode(JSON.stringify(header));
    const payloadEncoded = this.base64UrlEncode(JSON.stringify(payload));
    const data = `${headerEncoded}.${payloadEncoded}`;
    const signature = crypto
      .createHmac('sha256', this.getTokenSecret())
      .update(data)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    return `${data}.${signature}`;
  }

  private verifyJwt(token: string): Record<string, unknown> {
    const [headerEncoded, payloadEncoded, signature] = token.split('.');
    if (!headerEncoded || !payloadEncoded || !signature) {
      this.logger.warn('jwt_verify_failed cause=malformed');
      throw new UnauthorizedException('Invalid token');
    }

    const data = `${headerEncoded}.${payloadEncoded}`;
    const expectedSig = crypto
      .createHmac('sha256', this.getTokenSecret())
      .update(data)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    if (expectedSig !== signature) {
      this.logger.warn('jwt_verify_failed cause=signature_mismatch');
      throw new UnauthorizedException('Invalid token');
    }

    const payloadRaw = this.base64UrlDecode(payloadEncoded);
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
      this.logger.warn('jwt_verify_failed cause=expired');
      throw new UnauthorizedException('Token expired');
    }
    return payload;
  }

  private buildTokenPayload(user: User, tokenType: 'access' | 'refresh', ttlSec: number) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      sub: String(user.id),
      clientId: user.clientId,
      email: user.email,
      role: user.role,
      signupComplete: user.hasCompletedSignup,
      tokenType,
      iat: nowSec,
      exp: nowSec + ttlSec,
    };
  }

  issueTokenPair(user: User) {
    const accessPayload = this.buildTokenPayload(user, 'access', this.accessTokenTtlSec);
    const refreshPayload = this.buildTokenPayload(user, 'refresh', this.refreshTokenTtlSec);

    return {
      ok: true as const,
      accessToken: this.signJwt(accessPayload),
      refreshToken: this.signJwt(refreshPayload),
      expiresInSec: this.accessTokenTtlSec,
      user: this.toPublicUser(user),
    };
  }

  async issueTokenPairFromMagicLink(email: string, token: string) {
    const user = await this.verifyMagicLinkToken(token, email);
    return this.issueTokenPair(user);
  }

  async refreshTokenPair(refreshToken: string) {
    if (!refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }

    const payload = this.verifyJwt(refreshToken);
    if (payload.tokenType !== 'refresh') {
      this.logger.warn('refresh_rejected cause=wrong_token_type');
      throw new UnauthorizedException('Invalid refresh token');
    }

    const userId = Number(payload.sub || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      this.logger.warn('refresh_rejected cause=invalid_subject');
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`refresh_rejected cause=user_not_found userId=${userId}`);
      throw new UnauthorizedException('User not found');
    }

    return this.issueTokenPair(user);
  }

  async getUserFromAccessToken(token: string): Promise<User> {
    if (!token) {
      this.logger.warn('access_rejected cause=missing_token');
      throw new UnauthorizedException('Missing access token');
    }

    const payload = this.verifyJwt(token);
    if (payload.tokenType !== 'access') {
      this.logger.warn('access_rejected cause=wrong_token_type');
      throw new UnauthorizedException('Invalid access token');
    }

    const userId = Number(payload.sub || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      this.logger.warn('access_rejected cause=invalid_subject');
      throw new UnauthorizedException('Invalid access token');
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`access_rejected cause=user_not_found userId=${userId}`);
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  private getHeader(req: AuthenticatedRequest, key: string): string | undefined {
    const value = req.headers[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return undefined;
  }

  private parseHeaderUserId(req: AuthenticatedRequest): number | null {
    const raw = this.getHeader(req, 'x-user-id');
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private resolveHeaderAuth(req: AuthenticatedRequest) {
    const clientId = this.getHeader(req, 'x-client-id');
    const userId = this.parseHeaderUserId(req);
    const roleHeader = this.getHeader(req, 'x-user-role');
    const role =
      roleHeader === 'admin' || roleHeader === 'learner' ? roleHeader : undefined;

    if (!clientId && !userId) return null;

    return {
      clientId: clientId ?? null,
      userId,
      sessionId: this.getHeader(req, 'x-session-id'),
      email: this.getHeader(req, 'x-user-email'),
      role,
    };
  }

  private normalizeAppUrl(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private resolveAppBrand(appUrl: string): AppBrand {
    try {
      const hostname = new URL(appUrl).hostname.toLowerCase();
      if (hostname === 'cleachtadh.misneach.site') {
        return appBrands.cleachtadh;
      }
    } catch {
      // Fall through to default brand.
    }

    return appBrands.misneach;
  }

  private resolveMagicLinkAppUrl(candidate?: string): string {
    const fallback = this.normalizeAppUrl(this.config.get<string>('APP_URL') || '');
    const allowed = [
      fallback,
      ...String(this.config.get<string>('AUTH_ALLOWED_APP_URLS') || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => this.normalizeAppUrl(entry)),
    ].filter(Boolean);

    const normalizedCandidate = this.normalizeAppUrl(String(candidate || '').trim());
    if (normalizedCandidate && allowed.includes(normalizedCandidate)) {
      return normalizedCandidate;
    }

    return fallback;
  }

  async handleMagicLink(email: string, appBaseUrl?: string): Promise<{ message: string }> {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      this.logger.warn('magic_link_rejected cause=missing_email');
      throw new Error('Email is required');
    }

    let user = await this.userRepo.findOne({ where: { email: normalizedEmail } });
    if (!user) {
      user = this.userRepo.create({
        email: normalizedEmail,
        clientId: uuidv4(),
        role: 'learner',
        hasCompletedSignup: false,
      });
      await this.userRepo.save(user);
    } else if (!user.clientId) {
      user.clientId = uuidv4();
      await this.userRepo.save(user);
    }

    const appUrl = this.resolveMagicLinkAppUrl(appBaseUrl);
    const { token } = await this.magicLinkTokenStore.create({
      email: normalizedEmail,
      userId: user.id,
      appBaseUrl: appUrl,
      metadata: {
        clientId: user.clientId,
      },
    });

    const verifyUrl = `${appUrl}/auth/verify-request?token=${token}&email=${normalizedEmail}`;
    const brand = this.resolveAppBrand(appUrl);
    this.logger.log(
      `magic_link_generated userId=${user.id} clientId=${user.clientId} appUrl=${appUrl} deliveryMode=${this.config.get<string>('EMAIL_DELIVERY', 'send')}`,
    );

    const selectedTranslations = translations.en(brand);

    const emailTemplatePath = join(__dirname, '..', '..', 'public', 'email', 'magic-link.html');
    let emailHtml = await readFile(emailTemplatePath, 'utf-8');

    emailHtml = emailHtml
      .replace(/{{verifyUrl}}/g, verifyUrl)
      .replace(/{{brandName}}/g, brand.name)
      .replace(/{{brandTagline}}/g, brand.tagline)
      .replace(/{{t\.subject}}/g, selectedTranslations.subject)
      .replace(/{{t\.greeting}}/g, selectedTranslations.greeting)
      .replace(/{{t\.intro}}/g, selectedTranslations.intro)
      .replace(/{{t\.button}}/g, selectedTranslations.button)
      .replace(/{{t\.note}}/g, selectedTranslations.note)
      .replace(/{{t\.footer}}/g, selectedTranslations.footer);

    const deliveryMode = this.config.get<string>('EMAIL_DELIVERY', 'send');
    const emailText = [
      selectedTranslations.greeting,
      selectedTranslations.intro,
      verifyUrl,
      selectedTranslations.note,
    ].join('\n\n');

    if (deliveryMode === 'log') {
      // Clear, grep-friendly logs
      console.log('—— MAGIC LINK (EMAIL DELIVERY DISABLED) ——');
      console.log('To:', normalizedEmail);
      console.log('Verify URL:', verifyUrl);
      console.log('———————————————');
      this.logger.log(`magic_link_delivery_logged userId=${user.id} clientId=${user.clientId}`);

      return {
        message: 'Magic link generated (email delivery disabled)',
      };
    }

    const queued = await this.magicLinkEmailQueue.enqueue({
      type: 'email.send',
      purpose: 'auth.magic-link',
      to: normalizedEmail,
      subject: selectedTranslations.subject,
      html: emailHtml,
      text: emailText,
      metadata: {
        userId: user.id,
        clientId: user.clientId,
        appBaseUrl: appUrl,
      },
    });

    if (queued) {
      this.logger.log(`magic_link_email_queued userId=${user.id} clientId=${user.clientId}`);
      return { message: 'Magic link sent!' };
    }

    await this.resend.emails.send({
      from: this.config.get<string>('EMAIL_FROM'),
      to: normalizedEmail,
      subject: selectedTranslations.subject,
      html: emailHtml,
    });
    this.logger.log(`magic_link_delivered userId=${user.id} clientId=${user.clientId}`);

    return { message: 'Magic link sent!' };
  }

  async verifyMagicLinkToken(token: string, email: string): Promise<User> {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!token || !normalizedEmail) {
      this.logger.warn('magic_link_verify_failed cause=invalid_request');
      throw new BadRequestException('Invalid request');
    }

    try {
      await this.magicLinkTokenStore.consume({ token, email: normalizedEmail, purpose: 'login' });
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.warn(`magic_link_verify_failed email=${normalizedEmail} cause=token_not_found`);
        throw error;
      }
      if (error instanceof UnauthorizedException) {
        this.logger.warn(`magic_link_verify_failed email=${normalizedEmail} cause=${error.message}`);
        throw error;
      }
      throw error;
    }

    const user = await this.userRepo.findOne({ where: { email: normalizedEmail } });
    if (!user?.clientId) {
      this.logger.error(`magic_link_verify_failed email=${normalizedEmail} cause=missing_client_id`);
      throw new InternalServerErrorException('Client ID missing');
    }

    this.logger.log(
      `magic_link_verify_succeeded userId=${user.id} clientId=${user.clientId} signupComplete=${user.hasCompletedSignup}`,
    );

    return user;
  }

  async verifyMagicLink(token: string, email: string, res: Response) {
    const user = await this.verifyMagicLinkToken(token, email);

    res.cookie('session', user.clientId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days
      path: '/',
      sameSite: 'lax',
    });

    return user;
  }

  async ensureUserByEmail(email: string): Promise<User> {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('Email is required');
    }

    let user = await this.userRepo.findOne({ where: { email: normalized } });

    if (!user) {
      user = this.userRepo.create({
        email: normalized,
        clientId: uuidv4(),
        role: 'learner',
        hasCompletedSignup: false,
      });
      await this.userRepo.save(user);
      user = await this.userRepo.findOne({ where: { id: user.id } });
    } else if (!user.clientId) {
      user.clientId = uuidv4();
      await this.userRepo.save(user);
      user = await this.userRepo.findOne({ where: { id: user.id } });
    }

    if (!user) {
      throw new InternalServerErrorException('Unable to resolve user');
    }

    return user;
  }

  async updateProfile(
    user: User,
    body: {
      displayName?: unknown;
      avatarUrl?: unknown;
      dailyReminderEnabled?: unknown;
      dailyReminderTime?: unknown;
    },
  ): Promise<User> {
    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
      const value = String(body.displayName ?? '').trim();
      user.displayName = value ? value.slice(0, 120) : null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'avatarUrl')) {
      const value = String(body.avatarUrl ?? '').trim();
      user.avatarUrl = value ? value.slice(0, 512) : null;
    }

    if (typeof body.dailyReminderEnabled === 'boolean') {
      user.dailyReminderEnabled = body.dailyReminderEnabled;
    }

    if (typeof body.dailyReminderTime === 'string') {
      const value = body.dailyReminderTime.trim();
      if (/^\d{2}:\d{2}$/.test(value)) user.dailyReminderTime = value;
    }

    return this.userRepo.save(user);
  }

  async markSignupCompleteByUserId(userId: number): Promise<User> {
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('Invalid user ID');
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.hasCompletedSignup) {
      user.hasCompletedSignup = true;
      await this.userRepo.save(user);
    }

    return user;
  }

  async findUserByClientId(clientId: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { clientId } });
  }

  async getClientIdFromSession(req: AuthenticatedRequest): Promise<string> {
    const headerAuth = this.resolveHeaderAuth(req);
    if (headerAuth?.clientId) {
      return headerAuth.clientId;
    }

    const user = await this.getUserFromSession(req);
    return user.clientId;
  }

  async getUserFromSession(req: AuthenticatedRequest): Promise<User> {
    const headerAuth = this.resolveHeaderAuth(req);
    if (headerAuth?.userId) {
      const fromHeader = await this.userRepo.findOne({ where: { id: headerAuth.userId } });
      if (fromHeader) return fromHeader;
    }
    if (headerAuth?.clientId) {
      const fromHeader = await this.userRepo.findOne({ where: { clientId: headerAuth.clientId } });
      if (fromHeader) return fromHeader;
    }

    const authHeader = this.getHeader(req, 'authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        try {
          return await this.getUserFromAccessToken(token);
        } catch {
          // Fall through to session-based auth checks.
        }
      }
    }

    const sessionUser = req.session?.user;
    if (!sessionUser?.id) {
      this.logger.warn('session_resolve_failed cause=missing_session_user');
      throw new UnauthorizedException('User not authenticated');
    }

    const fromSession = await this.userRepo.findOne({ where: { id: sessionUser.id } });

    if (!fromSession) {
      this.logger.warn(`session_resolve_failed cause=session_user_not_found userId=${sessionUser.id}`);
      throw new UnauthorizedException('User not found');
    }

    return fromSession;
  }
}
