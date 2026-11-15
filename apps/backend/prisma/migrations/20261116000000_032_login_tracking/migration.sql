-- Sprint 032: login tracking for JQL currentLogin()/previousLogin()/lastLogin().
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "previousLoginAt" TIMESTAMP(3);
