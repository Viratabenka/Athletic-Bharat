import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { prisma } from '../lib/prisma.js';
import { z } from 'zod';
import { signupSchema } from '../schemas/tenant.js';
import { conflict } from '../lib/errors.js';
import { Role } from '@bharatathlete/db';

const require = createRequire(import.meta.url);
const { compare: bcryptCompare, hash: bcryptHash } = require('bcryptjs');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email?: string; password?: string } }>('/auth/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid email or password', code: 'VALIDATION_ERROR' });
    }
    const user = await prisma.user.findUnique({
      where: { email: body.data.email },
    });
    if (!user || !(await bcryptCompare(body.data.password, user.passwordHash))) {
      return reply.status(401).send({ error: 'Invalid email or password', code: 'UNAUTHORIZED' });
    }
    const token = app.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId ?? null,
      },
      { expiresIn: '7d' }
    );
    return reply.send({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } });
  });

  app.post<{
    Body: {
      schoolName?: string;
      slug?: string;
      adminName?: string;
      adminEmail?: string;
      password?: string;
      country?: string;
      state?: string;
      city?: string;
    };
  }>('/auth/signup', async (request, reply) => {
    const body = signupSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: body.error.flatten().fieldErrors,
      });
    }
    const data = body.data;
    const existingSlug = await prisma.tenant.findUnique({ where: { slug: data.slug } });
    if (existingSlug) throw conflict('School code is already taken. Choose another.');
    const existingEmail = await prisma.user.findUnique({ where: { email: data.adminEmail } });
    if (existingEmail) throw conflict('This email is already registered.');

    const passwordHash = await bcryptHash(data.password, 10);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const tenant = await prisma.tenant.create({
      data: {
        name: data.schoolName,
        slug: data.slug,
        city: data.city ?? '',
        state: data.state ?? '',
        country: data.country ?? undefined,
      },
    });
    await prisma.tenantSettings.create({
      data: { tenantId: tenant.id, sportsLimitTrial: 2 },
    });
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        plan: 'TRIAL',
        status: 'TRIALING',
        trialEndsAt,
      },
    });
    await prisma.user.create({
      data: {
        name: data.adminName,
        email: data.adminEmail,
        passwordHash,
        role: Role.SCHOOL_ADMIN,
        tenantId: tenant.id,
      },
    });
    return reply.status(201).send({ ok: true, tenantId: tenant.id, message: 'Account created. You can sign in now.' });
  });
}
