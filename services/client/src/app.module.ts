import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { User } from './auth/entities/User';
import { ChallengesModule } from './challenges/challenges.module';
import { AdminModule } from './admin/admin.module';
import { LexiconModule } from './lexicon/lexicon.module';
import { CoursesModule } from './courses/courses.module';
import { PomodoroModule } from './pomodoro/pomodoro.module';
import { LanguageSetting } from './settings/entities/LanguageSetting';
import { SettingsModule } from './settings/settings.module';
import { TranslationsModule } from './translations/translations.module';
import { UtilsModule } from './utils/utils.module';
import { FlashcardsModule } from './flashcards/flashcards.module';
import { PhrasebookModule } from './phrasebook/phrasebook.module';
import { FocusModule } from './focus/focus.module';
import { PracticeModule } from './practice/practice.module';
import { BusinessModule } from './business/business.module';
import { PaymentsModule } from './payments/payments.module';
import { DiscountsModule } from './discounts/discounts.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { SurveysModule } from './surveys/surveys.module';
import { HealthController } from './health.controller';
import { MobileModule } from './mobile/mobile.module';
import { DailyNote } from './daily-notes/daily-note.entity';
import { DailyNotesModule } from './daily-notes/daily-notes.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'mariadb',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [User, LanguageSetting, DailyNote],
      synchronize: true,
    }),
    AuthModule,
    SettingsModule,
    UtilsModule,
    TranslationsModule,
    LexiconModule,
    PomodoroModule,
    FlashcardsModule,
    PhrasebookModule,
    FocusModule,
    PracticeModule,
    BusinessModule,
    PaymentsModule,
    DiscountsModule,
    WaitlistModule,
    SurveysModule,
    CoursesModule,
    ChallengesModule,
    AdminModule,
    MobileModule,
    DailyNotesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
