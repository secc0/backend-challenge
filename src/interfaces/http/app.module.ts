import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Container } from '../../container';
import { AuthGuard } from './auth.guard';
import { CONTAINER, OperationsController, TransactionsController, WalletsController } from './controllers';

@Module({})
export class AppModule {
  static register(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, TransactionsController, OperationsController],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
