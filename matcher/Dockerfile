# EV2 fingerprint matcher (D94): SourceAFIS behind a tiny internal HTTP service.
#
# Build context: this folder (`matcher/`). The service is reachable ONLY inside the
# Docker network: docker-compose.prod.yml gives it no `ports:`, and every request
# must carry MATCHER_TOKEN. It stores nothing.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
# Dependencies first, in their own layer: a code change does not re-download them.
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/ev2-matcher.jar ./ev2-matcher.jar
# Not root: the service parses images sent over the network.
RUN useradd --system --no-create-home matcher
USER matcher
EXPOSE 8090
# Headless: SourceAFIS decodes PNG through ImageIO and needs no display or fonts.
# The heap stays small; a template is a few KB and a request carries at most a few
# hundred of them.
ENTRYPOINT ["java", "-Djava.awt.headless=true", "-Xmx256m", "-jar", "/app/ev2-matcher.jar"]
