package jakarta.persistence;

/** Test stub with the real Jakarta Persistence name; no dependency JAR is needed. */
public interface EntityManager {
  Query createNativeQuery(String sqlString);

  Query createQuery(String qlString);
}
